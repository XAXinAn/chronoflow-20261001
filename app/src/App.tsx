import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createNavigationContainerRef } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  AppProvider,
  useAppSessionState,
  useAppTheme,
  useRuntime,
  useRuntimeState,
} from './context/AppContext';
import { createRuntime } from './runtime';
import { buildConsentRecord, hasAcceptedPolicy } from './domain/consent';
import { registerBundledOcrEngine } from './vision/register';
import { AppUpdateProvider } from './updater/AppUpdater';
import { createSecureConsentStore, type ConsentStore } from './auth/consentStore';
import { migrateLegacyStorage } from './auth/storageMigration';
import { AgendaScreen } from './screens/AgendaScreen';
import { AccountDeletionScreen } from './screens/AccountDeletionScreen';
import { EventEditorScreen, type PlaceSelection } from './screens/EventEditorScreen';
import { EventPickerScreen, type PickedEvent } from './screens/EventPickerScreen';
import { FeedbackScreen } from './screens/FeedbackScreen';
import { EventImportScreen, type DraftEdit } from './screens/EventImportScreen';
import { AgentChatScreen } from './screens/AgentChatScreen';
import { LoginScreen } from './screens/LoginScreen';
import { LocationPickerScreen } from './screens/LocationPickerScreen';
import { LegalScreen } from './screens/LegalScreen';
import { OrgAccountsScreen } from './screens/OrgAccountsScreen';
import { ProfileEditScreen } from './screens/ProfileEditScreen';
import { AvatarCropScreen } from './screens/AvatarCropScreen';
import { OrgEventEditorScreen } from './screens/OrgEventEditorScreen';
import { OrgRecipientPickerScreen } from './screens/OrgRecipientPickerScreen';
import { OrgTabScreen } from './screens/OrgTabScreen';
import { PrivacyConsentScreen } from './screens/PrivacyConsentScreen';
import { RecurrencePickerScreen } from './screens/RecurrencePickerScreen';
import { ReminderPickerScreen } from './screens/ReminderPickerScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { AccountSecurityScreen } from './screens/AccountSecurityScreen';
import { TaskEditorScreen } from './screens/TaskEditorScreen';
import { TasksScreen } from './screens/TasksScreen';
import type { Recurrence } from './domain/recurrence';
import type { EventDraft } from './domain/eventDraft';
import { localDateKey } from './domain/agenda';
import { APP_TIMEZONE } from './domain/calendar';
import type { LegalDoc } from './domain/legal';
import type { OrgEvent } from './api/types';
import type { RecognizedDraft } from './domain/vision';
import { refreshLocalReminders } from './notifications/actions';
import { subscribeNotificationResponses } from './notifications/listener';
import type { NotificationRoute } from './notifications/route';

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
  /** 图片识别出来一批日程草稿：进确认页让用户补日期 / 改标题，再一键添加（spec §4.1.9） */
  onReviewDrafts: (drafts: RecognizedDraft[]) => void;
  /** 组织管理员在手机上新建并下发组织日程（spec §4.2.2） */
  onCreateOrgEvent: (dateKey: string) => void;
  /** 编辑自己下发的组织日程（spec §4.2.2：只有发起人能改） */
  onEditOrgEvent: (event: OrgEvent) => void;
  onOpenOrgEvent: (identityId: number, dateKey: string) => void;
  onOpenFeedback: () => void;
  /** 打开合规文本（隐私政策 / 用户协议 / 儿童声明 / 双清单） */
  onOpenLegal: (doc: LegalDoc) => void;
  /** 账号注销（规范 §2.7 要求 App 内必须有对应按钮） */
  onOpenDeletion: () => void;
  /** 改名字（昵称，spec §4.1.8）：昵称可改，服务端是 PATCH /me */
  onOpenProfileEdit: () => void;
  /** 「我的 → 账号与安全」：实名认证 + 邮箱绑定 */
  onOpenAccountSecurity: () => void;
  /** 选好头像原图后进取景页（正方框 + 拖动缩放，spec §4.1.8） */
  onOpenAvatarCrop: (uri: string) => void;
  /** 取景页裁完回传的本地图片（version 变了才处理） */
  avatarCrop: { version: number; uri: string | null };
};

function MainTabs({
  onCreateEvent,
  onOpenEvent,
  onCreateTask,
  onOpenTask,
  onOpenOrgAccounts,
  onCreateOrgEvent,
  onEditOrgEvent,
  onOpenOrgEvent,
  onReviewDrafts,
  onOpenFeedback,
  onOpenLegal,
  onOpenDeletion,
  onOpenProfileEdit,
  onOpenAccountSecurity,
  onOpenAvatarCrop,
  avatarCrop,
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
        /**
         * 键盘弹起时收起 tab 栏：小安的输入框在页面最底部，留着 tab 栏会跟键盘
         * 争同一块空间（要么输入框顶着 tab 栏、要么 tab 栏浮在键盘上）。
         * 微信、豆包在聊天页也都是键盘一出来就把底栏收掉。
         */
        tabBarHideOnKeyboard: true,
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
            // 图片识别出草稿后进确认页（spec §4.1.9）
            onReviewDrafts={onReviewDrafts}
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
            onEditOrgEvent={onEditOrgEvent}
          />
        )}
      </Tabs.Screen>
      {/* 小安常驻在导航里，位于「组织」之后（spec §11） */}
      <Tabs.Screen name="Agent" options={{ title: '小安', tabBarIcon: tabIcon('Agent') }}>
        {() => (
          <AgentChatScreen
            // 确认卡片建好日程后「查看日程」跳到编辑页：走的是与日历页同一条路径
            onOpenEvent={(eventId, dateKey) => onOpenEvent(eventId, dateKey, null)}
          />
        )}
      </Tabs.Screen>
      <Tabs.Screen name="Settings" options={{ title: '我的', tabBarIcon: tabIcon('Settings') }}>
        {() => (
          <SettingsScreen
            onOpenFeedback={onOpenFeedback}
            onOpenLegal={onOpenLegal}
            onOpenDeletion={onOpenDeletion}
            onOpenProfileEdit={onOpenProfileEdit}
            onOpenAccountSecurity={onOpenAccountSecurity}
            onOpenAvatarCrop={onOpenAvatarCrop}
            avatarCrop={avatarCrop}
          />
        )}
      </Tabs.Screen>
    </Tabs.Navigator>
  );
}

type AppStackParamList = {
  Main: undefined;
  EventEditor: { dateKey: string; eventId?: number; occurrenceDate?: string | null };
  /** 图片识别出的日程草稿 → 确认页（补日期 / 改标题 / 一键添加，spec §4.1.9） */
  EventImport: { drafts: RecognizedDraft[] };
  /** 确认页里点开的某一条草稿 → 整页编辑器（草稿模式，改完回传、不落库） */
  EventDraftEditor: { draft: EventDraft; dateKey: string };
  TaskEditor: { taskId?: number };
  OrgEventEditor: { dateKey: string; event?: OrgEvent };
  OrgRecipientPicker: undefined;
  LocationPicker: undefined;
  RecurrencePicker: { startDateKey: string; initial: Recurrence };
  ReminderPicker: { initial: number[] };
  EventPicker: undefined;
  Feedback: undefined;
  OrgAccounts: undefined;
  /** 改名字（昵称）：二级页而不是弹窗，键盘与校验都在同一套页面结构里（spec §4.1.8） */
  ProfileEdit: undefined;
  AccountSecurity: undefined;
  /** 头像取景：正方框 + 拖动缩放，确认后按框裁成 1:1（spec §4.1.8） */
  AvatarCrop: { uri: string };
  Legal: { doc: LegalDoc };
  AccountDeletion: undefined;
};

const AppStack = createNativeStackNavigator<AppStackParamList>();

/**
 * 通知点击后的跳转走这个 ref 而不是 `useNavigation`：
 * 监听通知的组件不在任何 Screen 里（它在整棵导航树之外），拿不到 navigation 对象。
 */
const navigationRef = createNavigationContainerRef<AppStackParamList>();

/** 回到前台时重排本地提醒的最小间隔：切来切去不该每次都打一次接口。 */
const REMINDER_RESYNC_INTERVAL_MS = 5 * 60 * 1000;

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
  // 重复规则 / 提醒的回传，和其他二级页一样用 version 表达「又选了一次」
  const [recurrenceSelection, setRecurrenceSelection] = useState<{
    version: number;
    recurrence: Recurrence | null;
  }>({ version: 0, recurrence: null });
  const [reminderSelection, setReminderSelection] = useState<{ version: number; minutes: number[] }>({
    version: 0,
    minutes: [],
  });
  /** 头像取景页裁好的本地图片；version 表达「又裁了一张」，与其它二级页回传同一套语义 */
  const [avatarCrop, setAvatarCrop] = useState<{ version: number; uri: string | null }>({
    version: 0,
    uri: null,
  });
  // 待办关联日程的回传，和地点一样用 version 表达「又选了一次」
  const [eventSelection, setEventSelection] = useState<{ version: number; event: PickedEvent | null }>({
    version: 0,
    event: null,
  });
  /**
   * 确认页点开某条草稿 → 编辑器保存后的回传。
   *
   * 与地点 / 重复 / 提醒同一套「version 变了才算改过」的语义：编辑器是栈里的整页，
   * 确认页一直在下面活着，靠这份回传把改好的草稿写回对应的那一行。
   */
  const [draftEdit, setDraftEdit] = useState<DraftEdit | null>(null);
  /** 正在编辑哪一行草稿（编辑器保存时要用它把结果对上号） */
  const [editingImportKey, setEditingImportKey] = useState('');
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
  const { setActiveOrgIdentityId, setOrgFocusDateKey, notificationEnabled } = useAppSessionState();
  const { api, reminders } = useRuntime();

  /**
   * 注册端侧 OCR 引擎（spec §4.1.9）。
   *
   * <p>「上传图片 → 识别日程」的第一段是手机本地的 OCR（图片不出手机），它是原生模块：
   * 这里只注册一个**代理**，实现要等第一次真的识别时才加载（启动路径上不碰原生模块，
   * 免得原生库有问题就让整个 App 打不开）。**Expo Go 里拿不到模块**时，
   * 界面会如实说「端侧识别需要开发版构建」，而不是静默失败或偷偷改成上传图片到服务器。
   * 第二段（文字 → 日程草稿）在服务端做。
   */
  useEffect(() => {
    registerBundledOcrEngine();
  }, []);

  /**
   * 本机提醒的定期重排（spec §4.5）。
   *
   * 只排一次不够：重复日程只排得出最近的若干次、别的设备改了提醒、用户把通知开关关掉
   * —— 这些都不会体现在本机的排期里。冷启动 + 回到前台各对齐一次，把差异收掉。
   */
  useEffect(() => {
    let lastRun = 0;
    const run = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastRun < REMINDER_RESYNC_INTERVAL_MS) {
        return;
      }
      lastRun = now;
      void refreshLocalReminders({ api, scheduler: reminders, enabled: notificationEnabled });
    };
    run(true);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        run(false);
      }
    });
    return () => subscription.remove();
  }, [api, reminders, notificationEnabled]);

  /**
   * 点通知进 App：跳到对应的编辑页（spec §4.5）。
   *
   * 冷启动的那一次点击由 `subscribeNotificationResponses` 补捞；未登录时这棵树还没挂上，
   * 登录后本函数会重新订阅，所以待处理的点击不会丢。
   */
  const [pendingRoute, setPendingRoute] = useState<NotificationRoute | null>(null);
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void subscribeNotificationResponses((route) => {
      if (!cancelled) {
        setPendingRoute(route);
      }
    })
      .then((off) => {
        dispose = off;
      })
      .catch(() => {
        // 没有通知模块（Web 预览）：忽略，不影响其它功能
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (!pendingRoute || !navigationRef.isReady()) {
      return;
    }
    if (pendingRoute.kind === 'EVENT') {
      // 与从列表进编辑页一样：先清掉二级页的回传，避免上一条日程的选择串进来
      setPlaceSelection({ version: 0, place: null });
      setRecurrenceSelection({ version: 0, recurrence: null });
      setReminderSelection({ version: 0, minutes: [] });
      navigationRef.navigate('EventEditor', {
        dateKey: pendingRoute.occurrenceDate ?? today,
        eventId: pendingRoute.eventId,
        occurrenceDate: pendingRoute.occurrenceDate,
      });
    } else {
      setEventSelection({ version: 0, event: null });
      setRecurrenceSelection({ version: 0, recurrence: null });
      setReminderSelection({ version: 0, minutes: [] });
      navigationRef.navigate('TaskEditor', { taskId: pendingRoute.taskId });
    }
    setPendingRoute(null);
  }, [pendingRoute, today]);

  return (
    <AppStack.Navigator screenOptions={{ headerShown: false }}>
      <AppStack.Screen name="Main">
        {({ navigation }) => (
          <MainTabs
            onCreateEvent={(dateKey) => {
              // 每次从列表进编辑页都重置二级页的回传，避免上一次的选择串到下一次
              setPlaceSelection({ version: 0, place: null });
              setRecurrenceSelection({ version: 0, recurrence: null });
              setReminderSelection({ version: 0, minutes: [] });
              navigation.navigate('EventEditor', { dateKey });
            }}
            onOpenEvent={(eventId, dateKey, occurrenceDate) => {
              // 编辑已有日程同样要重置地点；否则会把上一次「新建」时选的地点带进来
              setPlaceSelection({ version: 0, place: null });
              // 重复 / 提醒也一样：编辑页自己会把已有值拉回来预填
              setRecurrenceSelection({ version: 0, recurrence: null });
              setReminderSelection({ version: 0, minutes: [] });
              navigation.navigate('EventEditor', { dateKey, eventId, occurrenceDate });
            }}
            onCreateTask={() => {
              setEventSelection({ version: 0, event: null });
              // 待办编辑页也复用「重复 / 提醒」两个二级页，同样要重置回传
              setRecurrenceSelection({ version: 0, recurrence: null });
              setReminderSelection({ version: 0, minutes: [] });
              navigation.navigate('TaskEditor');
            }}
            onOpenTask={(taskId) => {
              setEventSelection({ version: 0, event: null });
              setRecurrenceSelection({ version: 0, recurrence: null });
              setReminderSelection({ version: 0, minutes: [] });
              navigation.navigate('TaskEditor', { taskId });
            }}
            onReviewDrafts={(drafts) => navigation.navigate('EventImport', { drafts })}
            onOpenOrgAccounts={() => navigation.navigate('OrgAccounts')}
            onCreateOrgEvent={(dateKey) => navigation.navigate('OrgEventEditor', { dateKey })}
            onEditOrgEvent={(event) =>
              navigation.navigate('OrgEventEditor', {
                dateKey: localDateKey(event.at, APP_TIMEZONE),
                event,
              })
            }
            // 检索命中的组织日程：切到那个组织、定位到那天、跳到组织 tab
            onOpenOrgEvent={(identityId, dateKey) => {
              setActiveOrgIdentityId(identityId);
              setOrgFocusDateKey(dateKey);
              navigation.navigate('Main', { screen: 'OrgEvents' });
            }}
            onOpenFeedback={() => navigation.navigate('Feedback')}
            onOpenLegal={(doc) => navigation.navigate('Legal', { doc })}
            onOpenDeletion={() => navigation.navigate('AccountDeletion')}
            onOpenProfileEdit={() => navigation.navigate('ProfileEdit')}
            onOpenAccountSecurity={() => navigation.navigate('AccountSecurity')}
            onOpenAvatarCrop={(uri) => navigation.navigate('AvatarCrop', { uri })}
            avatarCrop={avatarCrop}
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
            recurrenceSelection={recurrenceSelection}
            reminderSelection={reminderSelection}
            onPickLocation={() => {
              navigation.navigate('LocationPicker');
            }}
            // 把「当前值」当参数传给二级页：编辑页才知道自己这份草稿是什么
            onPickRecurrence={(current, startDateKey) =>
              navigation.navigate('RecurrencePicker', { startDateKey, initial: current })
            }
            onPickReminder={(current) => navigation.navigate('ReminderPicker', { initial: current })}
            onCancel={() => navigation.goBack()}
            onSaved={() => navigation.goBack()}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="EventImport">
        {({ navigation, route }) => (
          <EventImportScreen
            drafts={route.params.drafts}
            draftEdit={draftEdit}
            onEditDraft={(key, draft, dateKey) => {
              // 进草稿编辑器前清掉二级页的回传，避免上一次选的地点 / 重复 / 提醒串进来
              setPlaceSelection({ version: 0, place: null });
              setRecurrenceSelection({ version: 0, recurrence: null });
              setReminderSelection({ version: 0, minutes: [] });
              setEditingImportKey(key);
              navigation.navigate('EventDraftEditor', { draft, dateKey: dateKey ?? today });
            }}
            onCancel={() => navigation.goBack()}
            // 全部添加成功 → 回日历；日历页的 useFocusEffect 会自动重新拉取，新建的日程立刻可见
            onAdded={() => navigation.navigate('Main', { screen: 'Agenda' })}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="EventDraftEditor">
        {({ navigation, route }) => (
          <EventEditorScreen
            // 草稿模式：用识别出来的草稿起步，保存只回传给确认页，不写服务端
            dateKey={route.params.dateKey}
            initialDraft={route.params.draft}
            placeSelection={placeSelection}
            recurrenceSelection={recurrenceSelection}
            reminderSelection={reminderSelection}
            onPickLocation={() => navigation.navigate('LocationPicker')}
            onPickRecurrence={(current, startDateKey) =>
              navigation.navigate('RecurrencePicker', { startDateKey, initial: current })
            }
            onPickReminder={(current) => navigation.navigate('ReminderPicker', { initial: current })}
            onDraftSaved={(draft, dateKey) => {
              setDraftEdit((current) => ({
                version: (current?.version ?? 0) + 1,
                key: editingImportKey,
                draft,
                dateKey,
              }));
              navigation.goBack();
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
            recurrenceSelection={recurrenceSelection}
            reminderSelection={reminderSelection}
            onPickEvent={() => navigation.navigate('EventPicker')}
            onPickRecurrence={(current, startDateKey) =>
              navigation.navigate('RecurrencePicker', { startDateKey, initial: current })
            }
            onPickReminder={(current) => navigation.navigate('ReminderPicker', { initial: current })}
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
              setPlaceSelection((current) => ({ version: current.version + 1, place }));
              navigation.goBack();
            }}
          />
        )}
      </AppStack.Screen>

      {/* 重复规则的二级页（spec §4.1.5：重复、提醒各带自己的返回栈） */}
      <AppStack.Screen name="RecurrencePicker">
        {({ navigation, route }) => (
          <RecurrencePickerScreen
            startDateKey={route.params.startDateKey}
            initial={route.params.initial}
            onCancel={() => navigation.goBack()}
            onConfirm={(recurrence) => {
              setRecurrenceSelection((current) => ({ version: current.version + 1, recurrence }));
              navigation.goBack();
            }}
          />
        )}
      </AppStack.Screen>

      <AppStack.Screen name="ReminderPicker">
        {({ navigation, route }) => (
          <ReminderPickerScreen
            initial={route.params.initial}
            onCancel={() => navigation.goBack()}
            onConfirm={(minutes) => {
              setReminderSelection((current) => ({ version: current.version + 1, minutes }));
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

      <AppStack.Screen name="ProfileEdit">
        {({ navigation }) => <ProfileEditScreen onBack={() => navigation.goBack()} />}
      </AppStack.Screen>

      <AppStack.Screen name="AccountSecurity">
        {({ navigation }) => <AccountSecurityScreen onBack={() => navigation.goBack()} />}
      </AppStack.Screen>

      <AppStack.Screen name="AvatarCrop">
        {({ navigation, route }) => (
          <AvatarCropScreen
            uri={route.params.uri}
            onCancel={() => navigation.goBack()}
            onDone={(uri) => {
              // 裁好就回「我的」页：上传与资料回填都由那一页负责（它持有 profile 状态）
              setAvatarCrop((current) => ({ version: current.version + 1, uri }));
              navigation.goBack();
            }}
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
        // 改名遗留（xa-todo.* → chronoflow.*）：**必须在读任何存储之前**搬完，
        // 否则老包升上来的用户会莫名其妙掉登录态、重弹隐私同意
        await migrateLegacyStorage();
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

  /**
   * 应用内更新（spec §4.1.11）：Provider 挂在**同意隐私政策之后**，
   * 所以「同意前不发任何请求」这条依然成立；里面的启动检查是静默的
   * （没网 / 服务端没配发布信息都不会打扰用户），只有真发现新版本才弹。
   */
  return (
    <AppUpdateProvider>{session ? <MainStack /> : <AuthFlow />}</AppUpdateProvider>
  );
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
      <NavigationContainer theme={navTheme} ref={navigationRef}>
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
