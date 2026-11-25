import AsyncStorage from '@react-native-async-storage/async-storage';
import { createScanFilter } from '@inventory/shared';
import type { QueuedOp } from '@inventory/shared';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  FlatList,
  I18nManager,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';
import { createApiClient } from './src/api';
import type { Session } from './src/api';
import { playFeedback } from './src/feedback';
import type { FeedbackKind } from './src/feedback';
import { lookupFeedback } from './src/scan';
import { addToQueue, loadQueue, runQueue } from './src/sync';

// مسبار (س-1): شاشتان فقط للتحقق من الكاميرا والطابور والمزامنة على جهاز حقيقي، لا واجهة نهائية.
// Spike (س-1): two screens only, to verify camera, queue and sync on a real device; not the final UI.
const BASE_URL = 'https://inv.amrodev.com';
const SESSION_KEY = 'inventory.session';
I18nManager.allowRTL(true);

const store = {
  load: async (): Promise<Session | null> => {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  },
  save: async (s: Session | null): Promise<void> => {
    if (s) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s));
    else await SecureStore.deleteItemAsync(SESSION_KEY);
  },
};

// معرّف فريد تقريبي كافٍ للمسبار؛ للإنتاج expo-crypto (UUID). Unique enough for the spike; use expo-crypto UUIDs in production.
const HAPTIC_TYPE = {
  success: Haptics.NotificationFeedbackType.Success,
  error: Haptics.NotificationFeedbackType.Error,
  warning: Haptics.NotificationFeedbackType.Warning,
} as const;
const feedback = (kind: FeedbackKind): void => {
  void playFeedback(kind, {
    haptic: (k) => Haptics.notificationAsync(HAPTIC_TYPE[k]),
    vibrate: (pattern) => Vibration.vibrate(pattern),
  });
};

const newOpId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;

export const App = () => {
  const api = useMemo(
    () => createApiClient({ baseUrl: BASE_URL, fetch: (u, i) => fetch(u, i), store }),
    [],
  );
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [form, setForm] = useState({
    companyCode: 'demo',
    username: 'demo.auditor1',
    password: '',
  });
  const [message, setMessage] = useState('');
  const [queue, setQueue] = useState<readonly QueuedOp[]>([]);
  const [permission, requestPermission] = useCameraPermissions();
  const gate = useRef(createScanFilter());

  useEffect(() => {
    void api.isSignedIn().then(setSignedIn);
    void loadQueue(AsyncStorage).then(setQueue);
  }, [api]);

  const sync = async (): Promise<void> => {
    const r = await runQueue({
      storage: AsyncStorage,
      now: () => Date.now(),
      // المسبار: يتحقق أن الصنف موجود. الإرسال الحقيقي (أحداث المسح) يأتي مع المرحلة 3.
      // Spike: checks the item exists. The real send (scan events) arrives with phase 3.
      send: async (op) => {
        await api.get(`/items/by-barcode/${(op.payload as { barcode: string }).barcode}`);
      },
    });
    setQueue(await loadQueue(AsyncStorage));
    setMessage(`أُرسل ${r.sent} · فشل ${r.failed} · متبقٍ ${r.remaining}`);
  };

  const onScan = async (barcode: string): Promise<void> => {
    if (!gate.current(barcode, Date.now())) return;
    // الحفظ في الطابور أولاً وفي كل حال؛ البحث الفوري للتغذية الراجعة فقط.
    // Queue first, always; the instant lookup is feedback only.
    setQueue(
      await addToQueue(
        AsyncStorage,
        { id: newOpId(), kind: 'scan', payload: { barcode } },
        Date.now(),
      ),
    );
    setMessage(`سُجّل ${barcode} …`);
    const fb = await lookupFeedback(() =>
      api.get<{ name: string }>(`/items/by-barcode/${barcode}`),
    );
    if (fb.kind === 'found') {
      feedback('success');
      setMessage(`✔ ${fb.name} (${barcode})`);
    } else if (fb.kind === 'unknown') {
      feedback('error');
      setMessage(`✖ باركود غير معرّف: ${barcode}`);
    } else {
      feedback('warning');
      setMessage(`حُفظ دون اتصال: ${barcode}`);
    }
  };

  if (signedIn === null) return <Text style={styles.center}>…</Text>;

  if (!signedIn)
    return (
      <SafeAreaView style={styles.page}>
        <TextInput
          style={styles.input}
          value={form.companyCode}
          autoCapitalize="none"
          onChangeText={(v) => setForm({ ...form, companyCode: v })}
          placeholder="رمز الشركة"
        />
        <TextInput
          style={styles.input}
          value={form.username}
          autoCapitalize="none"
          onChangeText={(v) => setForm({ ...form, username: v })}
          placeholder="اسم المستخدم"
        />
        <TextInput
          style={styles.input}
          value={form.password}
          secureTextEntry
          onChangeText={(v) => setForm({ ...form, password: v })}
          placeholder="كلمة المرور"
        />
        <Button
          title="دخول"
          onPress={() => {
            api
              .login(form)
              .then(() => setSignedIn(true))
              .catch((e: Error) => setMessage(e.message));
          }}
        />
        <Text>{message}</Text>
        <StatusBar style="auto" />
      </SafeAreaView>
    );

  return (
    <SafeAreaView style={styles.page}>
      {permission?.granted ? (
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'code128', 'qr'] }}
          onBarcodeScanned={(r) => {
            onScan(r.data).catch((e: Error) => setMessage(`خطأ: ${e.message}`));
          }}
        />
      ) : (
        <Button title="السماح بالكاميرا" onPress={() => void requestPermission()} />
      )}
      <Text>{message}</Text>
      <FlatList
        data={[...queue].reverse()}
        keyExtractor={(q) => q.id}
        renderItem={({ item }) => (
          <View>
            <Text>
              {(item.payload as { barcode: string }).barcode} · {item.status}
              {item.lastError ? ` (${item.lastError})` : ''}
            </Text>
          </View>
        )}
      />
      <Button
        title={`مزامنة (${queue.length})`}
        onPress={() => {
          sync().catch((e: Error) => setMessage(`خطأ: ${e.message}`));
        }}
      />
      <Button
        title="خروج"
        onPress={() => {
          void api.logout().then(() => setSignedIn(false));
        }}
      />
      <StatusBar style="auto" />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  page: { flex: 1, padding: 16, gap: 8 },
  center: { flex: 1, textAlign: 'center', marginTop: 80 },
  input: { borderWidth: 1, borderRadius: 6, padding: 10 },
  camera: { height: 300 },
});
