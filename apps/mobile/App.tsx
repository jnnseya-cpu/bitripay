import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme, DarkTheme, type LinkingOptions } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text, View, Pressable } from 'react-native';
import * as Linking from 'expo-linking';
import { StoreProvider, useStore } from './src/lib/store';
import { light, darkTheme } from './src/lib/theme';
import { Toasts, Loading, Button, T } from './src/components/ui';
import { Onboarding, Login, Register } from './src/screens/Auth';
import { Home, More, Notifications } from './src/screens/Home';
import { Scan, PayTarget, Send, Receive, Requests } from './src/screens/Pay';
import { AddMoney, Withdraw, Exchange, Agents } from './src/screens/Money';
import { Move } from './src/screens/Move';
import { Remittance, Cards, Bills, Topup, GiftCards } from './src/screens/Services';
import { P2P, Trade } from './src/screens/P2P';
import { Activity, TxDetail, Settings, Security, Kyc, Referrals, Support, Statements } from './src/screens/Account';
import { Assist } from './src/screens/Assist';
import { Merchant, MerchantGateway, Agent } from './src/screens/Business';
import type { RootParams } from './src/navigation';

const Stack = createNativeStackNavigator<RootParams>();
const Tab = createBottomTabNavigator();

function TabIcon({ label, focused, ico }: { label: string; focused: boolean; ico: string }) {
  const { dark } = useStore();
  const th = dark ? darkTheme : light;
  return (
    <View style={{ alignItems: 'center', gap: 2, paddingTop: 6 }}>
      <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.6 }}>{ico}</Text>
      <Text style={{ fontSize: 10, color: focused ? th.primary : th.muted, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

function MainTabs() {
  const { t, dark } = useStore();
  const th = dark ? darkTheme : light;
  return (
    <Tab.Navigator screenOptions={{ headerShown: false, tabBarShowLabel: false, tabBarStyle: { backgroundColor: th.card, borderTopColor: th.border, height: 64 } }}>
      <Tab.Screen name="Home" component={Home} options={{ tabBarIcon: ({ focused }) => <TabIcon label={t('nav.dashboard')} ico="🏠" focused={focused} /> }} />
      <Tab.Screen name="ScanTab" component={Scan} options={{ tabBarIcon: ({ focused }) => <TabIcon label="Scan" ico="📷" focused={focused} /> }} />
      <Tab.Screen name="ReceiveTab" component={Receive} options={{ tabBarIcon: ({ focused }) => <TabIcon label={t('nav.receive')} ico="🔳" focused={focused} /> }} />
      <Tab.Screen name="ActivityTab" component={Activity} options={{ tabBarIcon: ({ focused }) => <TabIcon label="Activity" ico="📜" focused={focused} /> }} />
      <Tab.Screen name="MoreTab" component={More} options={{ tabBarIcon: ({ focused }) => <TabIcon label="More" ico="☰" focused={focused} /> }} />
    </Tab.Navigator>
  );
}

function LockScreen() {
  const { unlock, logout, dark } = useStore();
  const th = dark ? darkTheme : light;
  useEffect(() => {
    void unlock();
  }, [unlock]);
  return (
    <View style={{ flex: 1, backgroundColor: th.bg, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
      <Text style={{ fontSize: 48 }}>🔒</Text>
      <T bold size={22}>BitriPay is locked</T>
      <T muted center>Use your fingerprint or face to continue.</T>
      <Button title="Unlock" onPress={unlock} />
      <Pressable onPress={logout}><T muted>Sign out instead</T></Pressable>
    </View>
  );
}

const linking: LinkingOptions<RootParams> = {
  prefixes: [Linking.createURL('/'), 'bitripay://', 'https://pay.bitripay.app'],
  config: {
    screens: {
      QrLink: 'q',
      Checkout: 'pay/:code',
      Main: { screens: { Home: '', ScanTab: 'scan', ReceiveTab: 'receive', ActivityTab: 'activity', MoreTab: 'more' } },
    },
  },
};

function Root() {
  const { ready, locked, user, dark } = useStore();
  const th = dark ? darkTheme : light;
  if (!ready) return <Loading />;
  if (locked) return <LockScreen />;
  const navTheme = dark ? { ...DarkTheme, colors: { ...DarkTheme.colors, background: th.bg, card: th.card, text: th.text, primary: th.primary, border: th.border } } : { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: th.bg, card: th.card, text: th.text, primary: th.primary, border: th.border } };
  return (
    <NavigationContainer theme={navTheme} linking={linking}>
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: th.bg } }}>
        {!user ? (
          <>
            <Stack.Screen name="Onboarding" component={Onboarding} />
            <Stack.Screen name="Login" component={Login} />
            <Stack.Screen name="Register" component={Register} />
          </>
        ) : (
          <>
            <Stack.Screen name="Main" component={MainTabs} />
            <Stack.Screen name="Send" component={Send} />
            <Stack.Screen name="Move" component={Move} />
            <Stack.Screen name="PayTarget" component={PayTarget} />
            <Stack.Screen name="QrLink" component={Scan} />
            <Stack.Screen name="Checkout" component={PayTarget} />
            <Stack.Screen name="Requests" component={Requests} />
            <Stack.Screen name="AddMoney" component={AddMoney} />
            <Stack.Screen name="Withdraw" component={Withdraw} />
            <Stack.Screen name="Exchange" component={Exchange} />
            <Stack.Screen name="Agents" component={Agents} />
            <Stack.Screen name="Remittance" component={Remittance} />
            <Stack.Screen name="Cards" component={Cards} />
            <Stack.Screen name="Bills" component={Bills} />
            <Stack.Screen name="Topup" component={Topup} />
            <Stack.Screen name="GiftCards" component={GiftCards} />
            <Stack.Screen name="P2P" component={P2P} />
            <Stack.Screen name="Trade" component={Trade} />
            <Stack.Screen name="TxDetail" component={TxDetail} />
            <Stack.Screen name="Settings" component={Settings} />
            <Stack.Screen name="Security" component={Security} />
            <Stack.Screen name="Statements" component={Statements} />
            <Stack.Screen name="Assist" component={Assist} />
            <Stack.Screen name="Kyc" component={Kyc} />
            <Stack.Screen name="Referrals" component={Referrals} />
            <Stack.Screen name="Support" component={Support} />
            <Stack.Screen name="Notifications" component={Notifications} />
            <Stack.Screen name="Merchant" component={Merchant} />
            <Stack.Screen name="MerchantGateway" component={MerchantGateway} />
            <Stack.Screen name="Agent" component={Agent} />
          </>
        )}
      </Stack.Navigator>
      <Toasts />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StoreProvider>
        <StatusBar style="auto" />
        <Root />
      </StoreProvider>
    </SafeAreaProvider>
  );
}
