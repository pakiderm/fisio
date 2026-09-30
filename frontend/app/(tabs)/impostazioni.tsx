import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api";
import { useAuth } from "@/src/auth-context";
import { colors, radius, spacing } from "@/src/theme";
import type { Settings } from "@/src/types";

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { user, signOut } = useAuth();
  const settingsQ = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<Settings>("/settings"),
  });

  const [form, setForm] = useState<Settings | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [showLogout, setShowLogout] = useState(false);

  useEffect(() => {
    if (settingsQ.data && !form) setForm(settingsQ.data);
  }, [settingsQ.data]);

  const save = useMutation({
    mutationFn: (payload: Partial<Settings>) => api.put<Settings>("/settings", payload),
    onSuccess: (data) => {
      qc.setQueryData(["settings"], data);
      setForm(data);
      setSavedAt(Date.now());
    },
  });

  if (!form) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }

  const upd = (patch: Partial<Settings>) => setForm({ ...form, ...patch });
  const updPro = (patch: Partial<Settings["professional"]>) =>
    setForm({ ...form, professional: { ...form.professional, ...patch } });

  const submit = () => {
    save.mutate({
      hourly_rate: Number(form.hourly_rate),
      next_invoice_number: Number(form.next_invoice_number),
      invoice_suffix: form.invoice_suffix,
      stamp_duty: Number(form.stamp_duty),
      professional: form.professional,
    });
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.surfaceSecondary }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={{ paddingTop: insets.top, backgroundColor: colors.surface }}>
        <View style={styles.header}>
          <Text style={styles.title}>Impostazioni</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}
        keyboardShouldPersistTaps="handled"
      >
        <Section title="Fatturazione">
          <Field
            label="Tariffa oraria standard (€/h)"
            testID="setting-hourly-rate"
            value={String(form.hourly_rate)}
            onChangeText={(t) => upd({ hourly_rate: Number(t) || 0 })}
            keyboardType="decimal-pad"
          />
          <Field
            label="Prossimo numero fattura"
            testID="setting-next-number"
            value={String(form.next_invoice_number)}
            onChangeText={(t) => upd({ next_invoice_number: Number(t) || 0 })}
            keyboardType="number-pad"
          />
          <Field
            label="Suffisso fattura"
            testID="setting-suffix"
            value={form.invoice_suffix}
            onChangeText={(t) => upd({ invoice_suffix: t })}
          />
          <Field
            label="Importo bollo (€)"
            testID="setting-bollo"
            value={String(form.stamp_duty)}
            onChangeText={(t) => upd({ stamp_duty: Number(t) || 0 })}
            keyboardType="decimal-pad"
          />
        </Section>

        <Section title="Dati professionali (usati nella fattura)">
          <Field
            label="Nome"
            testID="setting-pro-name"
            value={form.professional.name}
            onChangeText={(t) => updPro({ name: t })}
          />
          <Field
            label="Indirizzo"
            testID="setting-pro-address"
            value={form.professional.address}
            onChangeText={(t) => updPro({ address: t })}
          />
          <Field
            label="Telefono"
            testID="setting-pro-phone"
            value={form.professional.phone}
            onChangeText={(t) => updPro({ phone: t })}
          />
          <Field
            label="Email"
            testID="setting-pro-email"
            value={form.professional.email}
            onChangeText={(t) => updPro({ email: t })}
            keyboardType="email-address"
          />
          <Field
            label="Partita IVA"
            testID="setting-pro-vat"
            value={form.professional.vat}
            onChangeText={(t) => updPro({ vat: t })}
          />
        </Section>

        {savedAt && (
          <View style={styles.savedRow}>
            <Ionicons name="checkmark-circle" size={16} color={colors.success} />
            <Text style={{ color: colors.success, fontWeight: "700" }}>Salvato</Text>
          </View>
        )}

        <Section title="Account">
          <View style={{ gap: 6 }}>
            <Text style={styles.fieldLabel}>Utente</Text>
            <Text style={styles.accountValue}>
              {user?.first_name} {user?.last_name}
            </Text>
            {!!user?.email && (
              <Text style={styles.accountEmail}>{user.email}</Text>
            )}
            <View style={styles.providers}>
              {(user?.auth_providers ?? []).map((p) => (
                <View key={p} style={styles.provPill}>
                  <Text style={styles.provText}>{p}</Text>
                </View>
              ))}
            </View>
          </View>
          <TouchableOpacity
            testID="logout-btn"
            onPress={() => setShowLogout(true)}
            style={styles.logoutBtn}
          >
            <Ionicons name="log-out-outline" size={18} color={colors.error} />
            <Text style={styles.logoutText}>Esci</Text>
          </TouchableOpacity>
        </Section>
      </ScrollView>

      <Modal
        visible={showLogout}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLogout(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Ionicons name="log-out-outline" size={36} color={colors.error} />
            <Text style={styles.modalTitle}>Esci dal profilo?</Text>
            <Text style={styles.modalBody}>
              Dovrai reinserire le credenziali per rientrare.
            </Text>
            <View style={{ flexDirection: "row", gap: spacing.sm, alignSelf: "stretch", marginTop: spacing.md }}>
              <TouchableOpacity
                testID="logout-cancel"
                onPress={() => setShowLogout(false)}
                style={[styles.modalBtn, { backgroundColor: colors.surfaceSecondary }]}
              >
                <Text style={{ color: colors.onSurface, fontWeight: "700" }}>Annulla</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="logout-confirm"
                onPress={async () => {
                  setShowLogout(false);
                  await signOut();
                }}
                style={[styles.modalBtn, { backgroundColor: colors.error }]}
              >
                <Text style={{ color: colors.onError, fontWeight: "700" }}>Esci</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <View
        style={[
          styles.footer,
          { paddingBottom: (insets.bottom || 0) + spacing.md },
        ]}
      >
        <TouchableOpacity
          testID="settings-save"
          onPress={submit}
          disabled={save.isPending}
          style={[styles.saveBtn, save.isPending && { opacity: 0.5 }]}
        >
          {save.isPending ? (
            <ActivityIndicator color={colors.onBrandPrimary} />
          ) : (
            <Text style={styles.saveText}>Salva</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Field(props: {
  label: string;
  testID: string;
  value: string;
  onChangeText: (t: string) => void;
  keyboardType?: "default" | "number-pad" | "decimal-pad" | "email-address";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChangeText}
        keyboardType={props.keyboardType ?? "default"}
        style={styles.input}
        placeholderTextColor={colors.muted}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
  },
  title: { fontSize: 28, fontWeight: "800", color: colors.onSurface },
  section: { marginBottom: spacing.xl },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.muted,
    marginLeft: spacing.sm,
    marginBottom: spacing.sm,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionBody: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  field: {},
  fieldLabel: { fontSize: 12, color: colors.muted, marginBottom: 6 },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 16,
    color: colors.onSurface,
  },
  savedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: spacing.sm,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  saveBtn: {
    backgroundColor: colors.brandPrimary,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveText: { color: colors.onBrandPrimary, fontWeight: "700", fontSize: 16 },
  accountValue: { fontSize: 16, fontWeight: "700", color: colors.onSurface },
  accountEmail: { fontSize: 13, color: colors.muted },
  providers: { flexDirection: "row", gap: 6, marginTop: 6 },
  provPill: {
    backgroundColor: colors.brandTertiary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  provText: { color: colors.onBrandTertiary, fontSize: 11, fontWeight: "700" },
  logoutBtn: {
    marginTop: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.error,
  },
  logoutText: { color: colors.error, fontWeight: "700", fontSize: 15 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  modalCard: {
    marginHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: "center",
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.onSurface,
    marginTop: spacing.sm,
  },
  modalBody: {
    fontSize: 14,
    color: colors.muted,
    textAlign: "center",
    marginTop: 4,
  },
  modalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
});
