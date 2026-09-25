import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { IdentityView } from './api/types';
import { AppProvider, useAppSessionState, useAppTheme, useRuntimeState } from './context/AppContext';
import { createRuntime } from './runtime';
import { AgendaScreen } from './screens/AgendaScreen';
import { EventEditorScreen, type PlaceSelection } from './screens/EventEditorScreen';
import { EventPickerScreen, type PickedEvent } from './screens/EventPickerScreen';
import { FeedbackScreen } from './screens/FeedbackScreen';
import { IdentitySelectScreen } from './screens/IdentitySelectScreen';
import { IdentitySwitchScreen } from './screens/IdentitySwitchScreen';
import { LoginScreen } from './screens/LoginScreen';
import { LocationPickerScreen } from './screens/LocationPickerScreen';
import { OrgEventsScreen } from './screens/OrgEventsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TaskEditorScreen } from './screens/TaskEditorScreen';
import { TasksScreen } from './screens/TasksScreen';
import { localDateKey } from './domain/agenda';
import { APP_TIMEZONE } from './domain/calendar';

type AuthStackParamList = {
  Login: undefined;
  IdentitySelect: { selectToken: string; identities: IdentityView[] };
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Tabs = createBottomTabNavigator();

/**
 * 底部导航图标。用线性图标 + 选中态实心，符合黑白极简的设计语言（spec §7.6.5）。
 *
 * 之前没配图标时 React Navigation 会渲染缺字体的占位符，看起来就是「乱码方块」。
 */
const TAB_ICONS: Record<string, { active: string; inactive: string }> = {
  Agenda: { active: 'calendar', inactive: 'calendar-outline' },
  Tasks: { active: 'checkbox', inactive: 'checkbox-outline' },
  OrgEvents: { active: 'business', inactive: 'business-outline' },
  Settings: { active: 'person', inactive: 'person-outline' },
};

function tabIcon(routeName: keyof typeof TAB_ICONS) {
  return ({ focused, color, size }: { focused: boolean; color: string; size: number }) => (
    <Ionicons
      name={(focused ? TAB_ICONS[routeName].active : TAB_ICONS[routeName].inactive) as never}
      size={size}
      color={color}
    />
  );
}

function AuthFlow() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login">
        {({ navigation }) => (
          <LoginScreen
            onNeedSelectIdentity={({ selectToken, identities }) =>
              navigation.navigate('IdentitySelect', { selectToken, identities })
            }
          />
        )}
      </AuthStack.Screen>
      <AuthStack.Screen name="IdentitySelect">
        {({ route, navigation }) => (
          <IdentitySelectScreen
            selectToken={route.params.selectToken}
            identities={route.params.identities}
            onBack={() => navigation.goBack()}
          />
        )}
      </AuthStack.Screen>
    </AuthStack.Navigator>
  );
}

type MainTabsProps = {
  onCreateEvent: (dateKey: string) => void;
  onOpenEvent: (eventId: number, dateKey: string, occurrenceDate: string | null) => void;
  onCreateTask: () => void;
  onOpenTask: (taskId: number) => void;
  onOpenIdentitySwitch: () => void;
  onOpenFeedback: () => void;
};

function MainTabs({
  onCreateEvent,
  onOpenEvent,
  onCreateTask,
  onOpenTask,
  onOpenIdentitySwitch,
  onOpenFeedback,
}: MainTabsProps) {
  const theme = useAppTheme();
  const { session } = useAppSessionState();
  // 组织 tab 只对组织身份可见；个人身份下它没有任何内容可展示
  const isOrgIdentity = session?.identityType === 'ORG_MEMBER';

  return (
    <Tabs.Navigator
      /**
       * 用身份 ID 做 key：切换身份时整棵 tab 树重建。
       *
       * 否则切回个人身份后，「组织」tab 虽然从列表里消失，但它**已经加载的数据**会留在内存里，
       * 用户会看到"个人身份下还能看到组织日程"——数据没错，是界面状态没跟着身份走。
       */
      key={session?.identityId ?? 'anonymous'}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.accent,
        tabBarInactiveTintColor: theme.color.textTertiary,
        tabBarStyle: { backgroundColor: theme.color.surfaceRaised, borderTopColor: theme.color.border },
      }}
    >
      <Tabs.Screen name="Agenda" options={{ title: '日历', tabBarIcon: tabIcon('Agenda') }}>
        {() => (
          <AgendaScreen
            onCreateEvent={onCreateEvent}
            onOpenEvent={onOpenEvent}
            // 日历页的检索会跨到待办，所以这里也要能直接打开待办编辑页（spec §4.1.7）
            onOpenTask={onOpenTask}
          />
        )}
      </Tabs.Screen>
      <Tabs.Screen name="Tasks" options={{ title: '待办', tabBarIcon: tabIcon('Tasks') }}>
        {() => <TasksScreen onCreateTask={onCreateTask} onOpenTask={onOpenTask} />}
      </Tabs.Screen>
      {isOrgIdentity ? (
        <Tabs.Screen
          name="OrgEvents"
          component={OrgEventsScreen}
          options={{ title: '组织', tabBarIcon: tabIcon('OrgEvents') }}
        />
      ) : null}
      <Tabs.Screen name="Settings" options={{ title: '我的', tabBarIcon: tabIcon('Settings') }}>
        {() => (
          <SettingsScreen
            onOpenIdentitySwitch={onOpenIdentitySwitch}
            onOpenFeedback={onOpenFeedback}
          />
        )}
      </Tabs.Screen>
    </Tabs.Navigator>
  );
}

type AppStackParamList = {
  Main: undefined;
  EventEditor: { dateKey: string; eventId?: number; occurrenceDate?: string | null };
  TaskEditor: { taskId?: number };
  LocationPicker: undefined;
  EventPicker: undefined;
  IdentitySwitch: undefined;
  Feedback: undefined;
};

const AppStack = createNativeStackNavigator<AppStackParamList>();

/**
 * 登录后的导航：Tab（日历 / 待办 / 组织 / 我的）+ 若干独立编辑页。
 *
 * 编辑页做成栈里的整页而不是弹窗（spec §4.1.5）：字段量已到系统日历级别，
 * 而且地点搜索需要自己的二级页面与返回栈。
 *
 * 地点选完要回传给编辑页，而它既要在跳转期间存活、又要能被「不设地点」显式置空，
 * 因此由本组件持有，用 version 表达「又选了一次」。
 */
function MainStack() {
  const [placeSelection, setPlaceSelection] = useState<PlaceSelection>({ version: 0, place: null });
  // 待办关联日程的回传，和地点一样用 version 表达「又选了一次」
  const [eventSelection, setEventSelection] = useState<{ version: number; event: PickedEvent | null }>({
    version: 0,
    event: null,
  });
  const today = useMemo(() => localDateKey(new Date().toISOString(), APP_TIMEZONE), []);

  return (
    <AppStack.Navigator screenOptions={{ headerShown: false }}>
      <AppStack.Screen name="Main">
        {({ navigation }) => (
          <MainTabs
            onCreateEvent={(dateKey) => {
              // 每次从列表进编辑页都重置地点，避免上一次的选择串到下一次
              setPlaceSelection({ version: 0, place: null });
              navigation.navigate('EventEditor', { dateKey });
            }}
            onOpenEvent={(eventId, dateKey, occurrenceDate) => {
              // 编辑已有日程同样要重置地点；否则会把上一次「新建」时选的地点带进来
              setPlaceSelection({ version: 0, place: null });
              navigation.navigate('EventEditor', { dateKey, eventId, occurrenceDate });
            }}
            onCreateTask={() => {
              setEventSelection({ version: 0, event: null });
              navigation.navigate('TaskEditor');
            }}
            onOpenTask={(taskId) => {
              setEventSelection({ version: 0, event: null });
              navigation.navigate('TaskEditor', { taskId });
            }}
            onOpenIdentitySwitch={() => navigation.navigate('IdentitySwitch')}
            onOpenFeedback={() => navigation.navigate('Feedback')}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="EventEditor">
        {({ navigation, route }) => (
          <EventEditorScreen
            dateKey={route.params.dateKey}
            eventId={route.params.eventId}
            occurrenceDate={route.params.occurrenceDate ?? null}
            placeSelection={placeSelection}
            onPickLocation={() => navigation.navigate('LocationPicker')}
            onCancel={() => navigation.goBack()}
            onSaved={() => navigation.goBack()}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="TaskEditor">
        {({ navigation, route }) => (
          <TaskEditorScreen
            todayKey={today}
            taskId={route.params?.taskId}
            eventSelection={eventSelection}
            onPickEvent={() => navigation.navigate('EventPicker')}
            onCancel={() => navigation.goBack()}
            onSaved={() => navigation.goBack()}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="EventPicker">
        {({ navigation }) => (
          <EventPickerScreen
            onCancel={() => navigation.goBack()}
            onPick={(event) => {
              setEventSelection((current) => ({ version: current.version + 1, event }));
              navigation.goBack();
            }}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="LocationPicker">
        {({ navigation }) => (
          <LocationPickerScreen
            initialLatitude={placeSelection.place?.latitude ?? null}
            initialLongitude={placeSelection.place?.longitude ?? null}
            onCancel={() => navigation.goBack()}
            onPick={(place) => {
              setPlaceSelection((current) => ({ version: current.version + 1, place }));
              navigation.goBack();
            }}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="IdentitySwitch">
        {({ navigation }) => (
          <IdentitySwitchScreen
            onCancel={() => navigation.goBack()}
            onSwitched={() => navigation.goBack()}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="Feedback">
        {({ navigation }) => <FeedbackScreen onBack={() => navigation.goBack()} />}
      </AppStack.Screen>
    </AppStack.Navigator>
  );
}

function Root() {
  const theme = useAppTheme();
  const { runtime, setRuntime } = useRuntimeState();
  const { session, setSession } = useAppSessionState();
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const created = await createRuntime(() => {
          void setSession(null);
        });
        if (cancelled) {
          return;
        }
        setRuntime(created);
        // 冷启动：读取安全存储中的会话，必要时在首次请求前静默续期
        setSession(await created.session.restore());
      } finally {
        if (!cancelled) {
          setBooting(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setRuntime, setSession]);

  if (booting || !runtime) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.bg }}>
        <ActivityIndicator color={theme.color.accent} />
        <Text style={{ color: theme.color.textTertiary, marginTop: 12 }}>正在恢复登录状态…</Text>
      </View>
    );
  }

  return session ? <MainStack /> : <AuthFlow />;
}

function ThemedRoot() {
  const theme = useAppTheme();
  const navTheme = useMemo(
    () =>
      theme.scheme === 'dark'
        ? { ...DarkTheme, colors: { ...DarkTheme.colors, background: theme.color.bg, card: theme.color.surfaceRaised, text: theme.color.textPrimary, border: theme.color.border, primary: theme.color.accent } }
        : { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: theme.color.bg, card: theme.color.surfaceRaised, text: theme.color.textPrimary, border: theme.color.border, primary: theme.color.accent } },
    [theme],
  );

  return (
    <>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
      <NavigationContainer theme={navTheme}>
        <Root />
      </NavigationContainer>
    </>
  );
}

export function App() {
  const systemScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return (
    <SafeAreaProvider>
      <AppProvider systemScheme={systemScheme}>
        <ThemedRoot />
      </AppProvider>
    </SafeAreaProvider>
  );
}
