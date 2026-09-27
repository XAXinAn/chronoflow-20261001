import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppProvider, useAppSessionState, useAppTheme, useRuntimeState } from './context/AppContext';
import { createRuntime } from './runtime';
import { buildConsentRecord, hasAcceptedPolicy } from './domain/consent';
import { createSecureConsentStore, type ConsentStore } from './auth/consentStore';
import { AgendaScreen } from './screens/AgendaScreen';
import { AccountDeletionScreen } from './screens/AccountDeletionScreen';
import { EventEditorScreen, type PlaceSelection } from './screens/EventEditorScreen';
import { EventPickerScreen, type PickedEvent } from './screens/EventPickerScreen';
import { FeedbackScreen } from './screens/FeedbackScreen';
import { AgentChatScreen } from './screens/AgentChatScreen';
import { LoginScreen } from './screens/LoginScreen';
import { LocationPickerScreen } from './screens/LocationPickerScreen';
import { LegalScreen } from './screens/LegalScreen';
import { OrgAccountsScreen } from './screens/OrgAccountsScreen';
import { OrgEventEditorScreen } from './screens/OrgEventEditorScreen';
import { OrgRecipientPickerScreen } from './screens/OrgRecipientPickerScreen';
import { OrgTabScreen } from './screens/OrgTabScreen';
import { PrivacyConsentScreen } from './screens/PrivacyConsentScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TaskEditorScreen } from './screens/TaskEditorScreen';
import { TasksScreen } from './screens/TasksScreen';
import { localDateKey } from './domain/agenda';
import { APP_TIMEZONE } from './domain/calendar';
import type { LegalDoc } from './domain/legal';
import type { RecognizedEventDraft } from './domain/vision';
import type { OrgEvent } from './api/types';
import { RecognizedEventsScreen } from './screens/RecognizedEventsScreen';

type AuthStackParamList = {
  Login: undefined;
  /** 登录页要能点开《用户服务协议》《隐私政策》原文（规范 §四） */
  Legal: { doc: LegalDoc };
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
  // 小安排在「组织」之后、「我的」之前（spec §11）
  Agent: { active: 'sparkles', inactive: 'sparkles-outline' },
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
      {/* 只登录个人账号（spec §3.2）：组织账号在组织 tab 的「账户管理」里认领 */}
      <AuthStack.Screen name="Login">
        {({ navigation }) => (
          <LoginScreen onOpenLegal={(doc) => navigation.navigate('Legal', { doc })} />
        )}
      </AuthStack.Screen>
      <AuthStack.Screen name="Legal">
        {({ navigation, route }) => (
          <LegalScreen doc={route.params.doc} onBack={() => navigation.goBack()} />
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
  onOpenOrgAccounts: () => void;
  /** 组织管理员在手机上新建并下发组织日程（spec §4.2.2） */
  onCreateOrgEvent: (dateKey: string) => void;
  /** 组织页拍照识别出的草稿：确认页里选下发对象后批量下发 */
  onOpenOrgRecognized: (payload: {
    drafts: RecognizedEventDraft[];
    photoUri: string;
    sourceLabel: string;
    deviceFallbackReason: string | null;
    origin: 'ORG';
  }) => void;
  /** 编辑自己下发的组织日程（spec §4.2.2：只有发起人能改） */
  onEditOrgEvent: (event: OrgEvent) => void;
  onOpenOrgEvent: (identityId: number, dateKey: string) => void;
  onOpenRecognized: (payload: {
    drafts: RecognizedEventDraft[];
    photoUri: string;
    sourceLabel: string;
    deviceFallbackReason: string | null;
  }) => void;
  onOpenFeedback: () => void;
  /** 打开合规文本（隐私政策 / 用户协议 / 儿童声明 / 双清单） */
  onOpenLegal: (doc: LegalDoc) => void;
  /** 账号注销（规范 §2.7 要求 App 内必须有对应按钮） */
  onOpenDeletion: () => void;
};

function MainTabs({
  onCreateEvent,
  onOpenEvent,
  onCreateTask,
  onOpenTask,
  onOpenOrgAccounts,
  onCreateOrgEvent,
  onOpenOrgRecognized,
  onEditOrgEvent,
  onOpenOrgEvent,
  onOpenRecognized,
  onOpenFeedback,
  onOpenLegal,
  onOpenDeletion,
}: MainTabsProps) {
  const theme = useAppTheme();
  const { session } = useAppSessionState();

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
            onOpenOrgEvent={onOpenOrgEvent}
            onOpenRecognized={onOpenRecognized}
          />
        )}
      </Tabs.Screen>
      <Tabs.Screen name="Tasks" options={{ title: '待办', tabBarIcon: tabIcon('Tasks') }}>
        {() => <TasksScreen onCreateTask={onCreateTask} onOpenTask={onOpenTask} />}
      </Tabs.Screen>
      {/*
        组织 tab **常驻**（spec §4.2.3）：没有绑定组织账号时展示空状态与添加入口。
        入口消失会让用户根本找不到「我在哪里加组织账号」。
      */}
      <Tabs.Screen name="OrgEvents" options={{ title: '组织', tabBarIcon: tabIcon('OrgEvents') }}>
        {() => (
          <OrgTabScreen
            onOpenAccounts={onOpenOrgAccounts}
            onCreateOrgEvent={onCreateOrgEvent}
            onOpenRecognized={onOpenOrgRecognized}
            onEditOrgEvent={onEditOrgEvent}
          />
        )}
      </Tabs.Screen>
      {/* 小安常驻在导航里，位于「组织」之后（spec §11） */}
      <Tabs.Screen name="Agent" options={{ title: '小安', tabBarIcon: tabIcon('Agent') }}>
        {() => <AgentChatScreen />}
      </Tabs.Screen>
      <Tabs.Screen name="Settings" options={{ title: '我的', tabBarIcon: tabIcon('Settings') }}>
        {() => (
          <SettingsScreen
            onOpenFeedback={onOpenFeedback}
            onOpenLegal={onOpenLegal}
            onOpenDeletion={onOpenDeletion}
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
  OrgEventEditor: { dateKey: string; event?: OrgEvent };
  OrgRecipientPicker: undefined;
  LocationPicker: undefined;
  EventPicker: undefined;
  Feedback: undefined;
  OrgAccounts: undefined;
  Legal: { doc: LegalDoc };
  AccountDeletion: undefined;
  RecognizedEvents: {
    drafts: RecognizedEventDraft[];
    photoUri: string;
    sourceLabel: string;
    deviceFallbackReason: string | null;
    /** 从组织页拍照识别过来的：确认页要选下发对象，并下发成组织日程（spec §4.1.9） */
    origin?: 'PERSONAL' | 'ORG';
  };
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
  /** 识别结果页选地点的回传：带 index，指明是改哪一条 */
  const [recognizedPlace, setRecognizedPlace] = useState<{
    version: number;
    index: number;
    place: PlaceSelection['place'];
  }>({ version: 0, index: -1, place: null });
  /** 选点页是从编辑页来的还是从识别结果页来的：两者回传目标不同 */
  const [pickerFor, setPickerFor] = useState<'editor' | 'recognized'>('editor');
  // 待办关联日程的回传，和地点一样用 version 表达「又选了一次」
  const [eventSelection, setEventSelection] = useState<{ version: number; event: PickedEvent | null }>({
    version: 0,
    event: null,
  });
  /**
   * 组织日程的「下发对象」：选人页挑好后回填。
   *
   * 编辑页和识别确认页共用这一份选择（同一时刻只有一个选人流程在跑），
   * 用 version 表达「又选了一次」，这样从选人页回来一定能刷新界面。
   */
  const [recipients, setRecipients] = useState<{ version: number; memberIds: number[] }>({
    version: 0,
    memberIds: [],
  });
  const today = useMemo(() => localDateKey(new Date().toISOString(), APP_TIMEZONE), []);
  const { setActiveOrgIdentityId, setOrgFocusDateKey, activeOrgIdentityId, orgApi } =
    useAppSessionState();

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
            onOpenOrgAccounts={() => navigation.navigate('OrgAccounts')}
            onCreateOrgEvent={(dateKey) => navigation.navigate('OrgEventEditor', { dateKey })}
            onEditOrgEvent={(event) =>
              navigation.navigate('OrgEventEditor', {
                dateKey: localDateKey(event.startAt, APP_TIMEZONE),
                event,
              })
            }
            onOpenOrgRecognized={(payload) => navigation.navigate('RecognizedEvents', payload)}
            // 检索命中的组织日程：切到那个组织、定位到那天、跳到组织 tab
            onOpenOrgEvent={(identityId, dateKey) => {
              setActiveOrgIdentityId(identityId);
              setOrgFocusDateKey(dateKey);
              navigation.navigate('Main', { screen: 'OrgEvents' });
            }}
            onOpenFeedback={() => navigation.navigate('Feedback')}
            onOpenLegal={(doc) => navigation.navigate('Legal', { doc })}
            onOpenDeletion={() => navigation.navigate('AccountDeletion')}
            onOpenRecognized={(payload) => navigation.navigate('RecognizedEvents', payload)}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="Legal">
        {({ navigation, route }) => (
          <LegalScreen doc={route.params.doc} onBack={() => navigation.goBack()} />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="AccountDeletion">
        {({ navigation }) => (
          <AccountDeletionScreen
            onBack={() => navigation.goBack()}
            // 注销页里也要能翻到隐私政策原文（它引用了第七章的注销条款）
            onOpenLegal={(doc) => navigation.navigate('Legal', { doc })}
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
            onPickLocation={() => {
              setPickerFor('editor');
              navigation.navigate('LocationPicker');
            }}
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

      {/* 新建组织日程：与个人日程编辑页一样是整页（spec §4.1.5 / §4.2.2） */}
      <AppStack.Screen name="OrgEventEditor">
        {({ navigation, route }) => (
          <OrgEventEditorScreen
            dateKey={route.params.dateKey}
            event={route.params.event}
            selectedMemberIds={recipients.memberIds}
            onPickRecipients={() => navigation.navigate('OrgRecipientPicker')}
            onCancel={() => navigation.goBack()}
            onSaved={(summary) =>
              Alert.alert('已下发', summary, [{ text: '好', onPress: () => navigation.goBack() }])
            }
          />
        )}
      </AppStack.Screen>

      {/* 选择下发对象：单独一页（按组织单位分组 + 搜索 + 整组全选 + 顶部已选列表） */}
      <AppStack.Screen name="OrgRecipientPicker">
        {({ navigation }) => (
          <OrgRecipientPickerScreen
            initialSelected={recipients.memberIds}
            onCancel={() => navigation.goBack()}
            onConfirm={(memberIds) => {
              setRecipients((current) => ({ version: current.version + 1, memberIds }));
              navigation.goBack();
            }}
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
              if (pickerFor === 'recognized') {
                setRecognizedPlace((current) => ({
                  version: current.version + 1,
                  index: current.index,
                  place,
                }));
              } else {
                setPlaceSelection((current) => ({ version: current.version + 1, place }));
              }
              navigation.goBack();
            }}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="Feedback">
        {({ navigation }) => <FeedbackScreen onBack={() => navigation.goBack()} />}
      </AppStack.Screen>

      <AppStack.Screen name="OrgAccounts">
        {({ navigation }) => <OrgAccountsScreen onBack={() => navigation.goBack()} />}
      </AppStack.Screen>

      <AppStack.Screen name="RecognizedEvents">
        {({ navigation, route }) => (
          <RecognizedEventsScreen
            drafts={route.params.drafts}
            photoUri={route.params.photoUri}
            sourceLabel={route.params.sourceLabel}
            deviceFallbackReason={route.params.deviceFallbackReason}
            orgApi={
              route.params.origin === 'ORG' && activeOrgIdentityId != null
                ? orgApi(activeOrgIdentityId)
                : null
            }
            selectedMemberIds={recipients.memberIds}
            onPickRecipients={() => navigation.navigate('OrgRecipientPicker')}
            pickedPlace={recognizedPlace}
            onPickPlace={(index) => {
              setPickerFor('recognized');
              setRecognizedPlace((current) => ({ ...current, index }));
              navigation.navigate('LocationPicker');
            }}
            onBack={() => navigation.goBack()}
            onCreated={(summary) =>
              Alert.alert('已完成', summary, [{ text: '好', onPress: () => navigation.goBack() }])
            }
          />
        )}
      </AppStack.Screen>
    </AppStack.Navigator>
  );
}

function Root() {
  const theme = useAppTheme();
  const { runtime, setRuntime } = useRuntimeState();
  const { session, setSession } = useAppSessionState();
  const [booting, setBooting] = useState(true);
  /**
   * 首启隐私政策同意（规范 §四 D1/D3）。
   *
   * 这一层刻意放在**登录之前、网络请求之前**：
   * 未同意时连会话都不恢复，App 不会发出任何携带个人信息的请求。
   */
  const [consentChecked, setConsentChecked] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(true);
  const consentStoreRef = useRef<ConsentStore | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const store = await createSecureConsentStore();
        if (cancelled) {
          return;
        }
        consentStoreRef.current = store;
        setNeedsConsent(!hasAcceptedPolicy(await store.read()));
      } catch {
        // 安全存储不可用（例如 Web 预览）：按「没同意过」处理，宁可多弹一次
        if (!cancelled) {
          setNeedsConsent(true);
        }
      } finally {
        if (!cancelled) {
          setConsentChecked(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const acceptConsent = () => {
    const record = buildConsentRecord();
    setNeedsConsent(false);
    void consentStoreRef.current?.write(record);
  };

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

  if (booting || !runtime || !consentChecked) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.bg }}>
        <ActivityIndicator color={theme.color.accent} />
        <Text style={{ color: theme.color.textTertiary, marginTop: 12 }}>正在准备…</Text>
      </View>
    );
  }

  if (needsConsent) {
    return <PrivacyConsentScreen onAgree={acceptConsent} onDecline={() => undefined} />;
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
