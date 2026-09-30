import Ionicons from "@react-native-vector-icons/ionicons";
import { useRouter } from "expo-router";
import { useState } from "react";
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

export default function RegisterScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { register } = useAuth();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const doRegister = async () => {
    setError("");
    if (!firstName.trim() || !lastName.trim() || !email.trim() || password.length < 6) {
      setError("Tutti i campi sono obbligatori. Password almeno 6 caratteri.");
      return;
    }
    try {
      setBusy(true);
      await register(
        email.trim().toLowerCase(),
        password,
        firstName.trim(),
        lastName.trim(),
      );
    } catch (e: any) {
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
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} testID="reg-back">
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Registrati</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 60 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.intro}>
          Crea il tuo account personale. I tuoi dati saranno associati soltanto al tuo profilo.
        </Text>

        <View style={styles.card}>
          <Field
            label="Nome"
            testID="reg-first-name"
            value={firstName}
            onChangeText={setFirstName}
            autoCapitalize="words"
          />
          <Field
            label="Cognome"
            testID="reg-last-name"
            value={lastName}
            onChangeText={setLastName}
            autoCapitalize="words"
          />
          <Field
            label="Email"
            testID="reg-email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <Field
            label="Password (almeno 6 caratteri)"
            testID="reg-password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />

          <TouchableOpacity
            testID="reg-submit"
            onPress={doRegister}
            disabled={busy}
            style={[styles.primary, busy && { opacity: 0.5 }]}
          >
            {busy ? (
              <ActivityIndicator color={colors.onBrandPrimary} />
            ) : (
              <Text style={styles.primaryText}>Crea account</Text>
            )}
          </TouchableOpacity>
        </View>

        {!!error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field(props: {
  label: string;
  testID: string;
  value: string;
  onChangeText: (t: string) => void;
  keyboardType?: "default" | "email-address";
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "words";
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
        placeholderTextColor={colors.muted}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerTitle: { fontSize: 17, fontWeight: "700", color: colors.onSurface },
  intro: { color: colors.muted, fontSize: 14, marginBottom: spacing.lg },
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
});
