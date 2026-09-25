import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { IdentityView } from './api/types';
import { AppProvider, useAppSessionState, useAppTheme, useRuntimeState } from './context/AppContext';
import { createRuntime } from './runtime';
import { AgendaScreen } from './screens/AgendaScreen';
import { IdentitySelectScreen } from './screens/IdentitySelectScreen';
import { LoginScreen } from './screens/LoginScreen';
import { OrgEventsScreen } from './screens/OrgEventsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { TasksScreen } from './screens/TasksScreen';

type AuthStackParamList = {
  Login: undefined;
  IdentitySelect: { selectToken: string; identities: IdentityView[] };
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Tabs = createBottomTabNavigator();

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

function MainTabs() {
  const theme = useAppTheme();
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.color.accent,
        tabBarInactiveTintColor: theme.color.textTertiary,
        tabBarStyle: { backgroundColor: theme.color.surfaceRaised, borderTopColor: theme.color.border },
      }}
    >
      <Tabs.Screen name="Agenda" component={AgendaScreen} options={{ title: '日程' }} />
      <Tabs.Screen name="Tasks" component={TasksScreen} options={{ title: '待办' }} />
      <Tabs.Screen name="OrgEvents" component={OrgEventsScreen} options={{ title: '组织' }} />
      <Tabs.Screen name="Settings" component={SettingsScreen} options={{ title: '我的' }} />
    </Tabs.Navigator>
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

  return session ? <MainTabs /> : <AuthFlow />;
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
