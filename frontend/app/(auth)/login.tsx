import Ionicons from "@react-native-vector-icons/ionicons";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "@/src/auth-context";
import { colors, radius, spacing } from "@/src/theme";

// Complete WebBrowser auth session on iOS
WebBrowser.maybeCompleteAuthSession();

function extractSessionId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/[?#&]session_id=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn, signInWithGoogleSessionId, signInWithApple } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [appleAvailable, setAppleAvailable] = useState(false);
  const processedSessionIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (Platform.OS === "ios") {
      AppleAuthentication.isAvailableAsync().then(setAppleAvailable);
    }
  }, []);

  // Handle deep link session_id on cold start + hot links
  useEffect(() => {
    const handle = async (url: string | null | undefined) => {
      const sid = extractSessionId(url);
      if (!sid || processedSessionIds.current.has(sid)) return;
      processedSessionIds.current.add(sid);
      try {
        setBusy(true);
        await signInWithGoogleSessionId(sid);
      } catch (e: any) {
        setError(String(e.message || e));
      } finally {
        setBusy(false);
      }
    };
    // Web: check current URL hash/search
    if (Platform.OS === "web" && typeof window !== "undefined") {
      handle(window.location.hash + " " + window.location.search).then(() => {
        // Clean the URL if we processed a session_id
        if (window.location.hash.includes("session_id=") || window.location.search.includes("session_id=")) {
          window.history.replaceState(
            window.history.state,
            "",
            window.location.pathname,
          );
        }
      });
    }
    // Mobile: initial URL + listener
    Linking.getInitialURL().then((u) => handle(u));
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doLogin = async () => {
    setError("");
    if (!email.trim() || !password) {
      setError("Inserisci email e password");
      return;
    }
    try {
      setBusy(true);
      await signIn(email.trim().toLowerCase(), password);
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const doGoogle = async () => {
    setError("");
    try {
      setBusy(true);
      const redirect =
        Platform.OS === "web"
          ? `${window.location.origin}/`
          : Linking.createURL("");
      const authUrl = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(
        redirect,
      )}`;
      if (Platform.OS === "web") {
        window.location.href = authUrl;
        return;
      }
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirect);
      const urlFromResult =
        result.type === "success" ? (result as any).url : null;
      const sid =
        extractSessionId(urlFromResult) ??
        extractSessionId(await Linking.getInitialURL());
      if (sid && !processedSessionIds.current.has(sid)) {
        processedSessionIds.current.add(sid);
        await signInWithGoogleSessionId(sid);
      }
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const doApple = async () => {
    setError("");
    try {
      setBusy(true);
      // A random nonce per attempt
      const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const c = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce,
      });
      if (!c.identityToken) throw new Error("Apple non ha restituito il token");
      await signInWithApple(
        c.identityToken,
        nonce,
        c.fullName?.givenName ?? undefined,
        c.fullName?.familyName ?? undefined,
      );
    } catch (e: any) {
      if (e?.code === "ERR_REQUEST_CANCELED" || e?.code === "ERR_CANCELED") {
        return;
      }
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.surface }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 40 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.logo}>
          <Ionicons name="medical" size={44} color={colors.onBrandPrimary} />
        </View>
        <Text style={styles.title}>FisioManager</Text>
        <Text style={styles.subtitle}>Accedi al tuo studio</Text>

        <View style={{ height: spacing.xl }} />

        <View style={styles.card}>
          <Field
            label="Email"
            testID="in-email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
          />
          <Field
            label="Password"
            testID="in-password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
          />
          <TouchableOpacity
            testID="login-btn"
            onPress={doLogin}
            disabled={busy}
            style={[styles.primary, busy && { opacity: 0.6 }]}
          >
            {busy ? (
              <ActivityIndicator color={colors.onBrandPrimary} />
            ) : (
              <Text style={styles.primaryText}>Accedi</Text>
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.divider}>
          <View style={styles.line} />
          <Text style={styles.dividerText}>oppure</Text>
          <View style={styles.line} />
        </View>

        <TouchableOpacity
          testID="google-btn"
          onPress={doGoogle}
          disabled={busy}
          style={[styles.social, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Ionicons name="logo-google" size={20} color="#4285F4" />
          <Text style={[styles.socialText, { color: colors.onSurface }]}>Continua con Google</Text>
        </TouchableOpacity>

        {appleAvailable && (
          <TouchableOpacity
            testID="apple-btn"
            onPress={doApple}
            disabled={busy}
            style={[styles.social, { backgroundColor: "#000" }]}
          >
            <Ionicons name="logo-apple" size={20} color="#FFF" />
            <Text style={[styles.socialText, { color: "#FFF" }]}>Continua con Apple</Text>
          </TouchableOpacity>
        )}

        {!!error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <TouchableOpacity
          testID="go-register"
          onPress={() => router.push("/(auth)/registrati")}
          style={{ marginTop: spacing.xl, alignItems: "center" }}
        >
          <Text style={styles.linkText}>
            Non hai un account? <Text style={styles.linkBold}>Registrati</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field(props: {
  label: string;
  testID: string;
  value: string;
  onChangeText: (t: string) => void;
  keyboardType?: "default" | "email-address" | "number-pad";
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoComplete?: any;
}) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChangeText}
        keyboardType={props.keyboardType ?? "default"}
        secureTextEntry={props.secureTextEntry}
        autoCapitalize={props.autoCapitalize ?? "none"}
        autoComplete={props.autoComplete}
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingHorizontal: spacing.lg, paddingBottom: 60 },
  logo: {
    alignSelf: "center",
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  title: { textAlign: "center", fontSize: 28, fontWeight: "800", color: colors.onSurface },
  subtitle: { textAlign: "center", color: colors.muted, marginTop: 4 },
  card: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.lg,
    borderRadius: radius.md,
  },
  fieldLabel: { color: colors.muted, fontSize: 12, marginBottom: 6 },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.onSurface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  primary: {
    marginTop: spacing.sm,
    backgroundColor: colors.brandPrimary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryText: { color: colors.onBrandPrimary, fontWeight: "700", fontSize: 16 },

  divider: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: spacing.xl,
    gap: spacing.md,
  },
  line: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.muted, fontSize: 12 },

  social: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: radius.md,
    paddingVertical: 14,
    marginBottom: spacing.sm,
    borderWidth: 1,
  },
  socialText: { fontSize: 15, fontWeight: "600" },

  errorBox: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    padding: spacing.md,
    backgroundColor: "#FFF0F0",
    borderRadius: radius.sm,
  },
  errorText: { color: colors.error, flex: 1, fontSize: 13 },

  linkText: { color: colors.muted, fontSize: 14 },
  linkBold: { color: colors.brandPrimary, fontWeight: "700" },
});
