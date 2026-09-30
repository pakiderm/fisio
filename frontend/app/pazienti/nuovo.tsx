import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
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

import { api } from "@/src/api";
import { colors, radius, spacing } from "@/src/theme";
import type { Patient } from "@/src/types";

export default function PatientFormScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; edit?: string }>();
  const isEdit = !!(params.id && params.id !== "nuovo" && params.edit === "1");
  const qc = useQueryClient();

  const patientQ = useQuery({
    queryKey: ["patient", params.id],
    queryFn: () => api.get<Patient>(`/patients/${params.id}`),
    enabled: isEdit,
  });

  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    codice_fiscale: "",
    address: "",
    city: "",
    cap: "",
    hcp_code: "",
    custom_hourly_rate: "" as string,
  });

  useEffect(() => {
    if (isEdit && patientQ.data) {
      setForm({
        first_name: patientQ.data.first_name || "",
        last_name: patientQ.data.last_name || "",
        codice_fiscale: patientQ.data.codice_fiscale || "",
        address: patientQ.data.address || "",
        city: patientQ.data.city || "",
        cap: patientQ.data.cap || "",
        hcp_code: patientQ.data.hcp_code || "",
        custom_hourly_rate:
          patientQ.data.custom_hourly_rate != null ? String(patientQ.data.custom_hourly_rate) : "",
      });
    }
  }, [patientQ.data, isEdit]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ...form,
        custom_hourly_rate: form.custom_hourly_rate.trim()
          ? Number(form.custom_hourly_rate)
          : null,
      };
      if (isEdit && params.id) {
        return api.put<Patient>(`/patients/${params.id}`, body);
      }
      return api.post<Patient>("/patients", body);
    },
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["patient", p.id] });
      if (isEdit) router.back();
      else router.replace(`/pazienti/${p.id}`);
    },
  });

  const canSave = !!form.first_name.trim() && !!form.last_name.trim();

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.surfaceSecondary }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} testID="cancel">
          <Text style={styles.cancelText}>Annulla</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{isEdit ? "Modifica paziente" : "Nuovo paziente"}</Text>
        <TouchableOpacity
          onPress={() => canSave && save.mutate()}
          disabled={!canSave || save.isPending}
          testID="save-patient"
        >
          <Text style={[styles.saveText, !canSave && { opacity: 0.4 }]}>Salva</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 }}>
        <Section title="Anagrafica">
          <Field
            label="Cognome *"
            testID="in-last-name"
            value={form.last_name}
            onChangeText={(t) => setForm({ ...form, last_name: t })}
          />
          <Field
            label="Nome *"
            testID="in-first-name"
            value={form.first_name}
            onChangeText={(t) => setForm({ ...form, first_name: t })}
          />
          <Field
            label="Codice fiscale"
            testID="in-cf"
            value={form.codice_fiscale}
            onChangeText={(t) => setForm({ ...form, codice_fiscale: t.toUpperCase() })}
            autoCapitalize="characters"
          />
        </Section>

        <Section title="Indirizzo">
          <Field
            label="Indirizzo"
            testID="in-address"
            value={form.address}
            onChangeText={(t) => setForm({ ...form, address: t })}
          />
          <View style={{ flexDirection: "row", gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Field
                label="Città"
                testID="in-city"
                value={form.city}
                onChangeText={(t) => setForm({ ...form, city: t })}
              />
            </View>
            <View style={{ width: 100 }}>
              <Field
                label="CAP"
                testID="in-cap"
                value={form.cap}
                onChangeText={(t) => setForm({ ...form, cap: t })}
                keyboardType="number-pad"
              />
            </View>
          </View>
        </Section>

        <Section title="Fatturazione">
          <Field
            label="Codice / numero pratica HCP"
            testID="in-hcp"
            value={form.hcp_code}
            onChangeText={(t) => setForm({ ...form, hcp_code: t })}
          />
          <Field
            label="Tariffa oraria personalizzata (€/h)"
            testID="in-rate"
            value={form.custom_hourly_rate}
            onChangeText={(t) => setForm({ ...form, custom_hourly_rate: t })}
            keyboardType="decimal-pad"
            placeholder="Lascia vuoto per usare la tariffa standard"
          />
        </Section>

        {save.isError && (
          <Text style={styles.error}>{(save.error as Error).message}</Text>
        )}
      </ScrollView>
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
  keyboardType?: "default" | "number-pad" | "decimal-pad";
  autoCapitalize?: "none" | "characters";
  placeholder?: string;
}) {
  return (
    <View>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        value={props.value}
        onChangeText={props.onChangeText}
        keyboardType={props.keyboardType ?? "default"}
        autoCapitalize={props.autoCapitalize}
        placeholder={props.placeholder}
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
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.onSurface },
  cancelText: { color: colors.muted, fontSize: 16 },
  saveText: { color: colors.brandPrimary, fontWeight: "700", fontSize: 16 },
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
  fieldLabel: { fontSize: 12, color: colors.muted, marginBottom: 6 },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.onSurface,
  },
  error: {
    color: colors.error,
    textAlign: "center",
    marginTop: spacing.md,
  },
});
