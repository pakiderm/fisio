import Ionicons from "@react-native-vector-icons/ionicons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api";
import { MONTHS_IT, euro, initials, minutesToText } from "@/src/format";
import { colors, radius, spacing } from "@/src/theme";
import type { History, Patient } from "@/src/types";

export default function PatientDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const patientQ = useQuery({
    queryKey: ["patient", params.id],
    queryFn: () => api.get<Patient>(`/patients/${params.id}`),
  });
  const historyQ = useQuery({
    queryKey: ["history", params.id],
    queryFn: () => api.get<History>(`/patients/${params.id}/history`),
  });

  const del = useMutation({
    mutationFn: () => api.delete(`/patients/${params.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      router.back();
    },
  });

  if (patientQ.isLoading || historyQ.isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }
  const p = patientQ.data;
  if (!p) return null;
  const totals = historyQ.data?.totals ?? { count: 0, hours: 0, amount: 0 };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
              <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              testID="edit-patient"
              onPress={() =>
                router.push({ pathname: "/pazienti/nuovo", params: { id: p.id, edit: "1" } })
              }
              style={styles.iconBtn}
            >
              <Ionicons name="pencil" size={18} color={colors.onSurface} />
            </TouchableOpacity>
          </View>

          <View style={styles.avatarWrap}>
            <View style={styles.avatarLg}>
              <Text style={styles.avatarLgText}>{initials(p.first_name, p.last_name)}</Text>
            </View>
            <Text style={styles.name}>
              {p.last_name} {p.first_name}
            </Text>
            {!!p.codice_fiscale && <Text style={styles.subtle}>{p.codice_fiscale}</Text>}
            {!!p.hcp_code && (
              <View style={styles.hcpBadge}>
                <Text style={styles.hcpBadgeText}>Pratica HCP {p.hcp_code}</Text>
              </View>
            )}
          </View>

          <View style={styles.kpiRow}>
            <KPI value={String(totals.count)} label="Sedute" />
            <KPI value={`${totals.hours}h`} label="Ore" />
            <KPI value={euro(totals.amount)} label="Totale" />
          </View>
        </View>

        <View style={{ padding: spacing.lg }}>
          <Text style={styles.sectionTitle}>Storico terapie</Text>
          {(historyQ.data?.years ?? []).length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="calendar-outline" size={40} color={colors.muted} />
              <Text style={styles.emptyText}>Nessuna terapia registrata</Text>
            </View>
          ) : (
            (historyQ.data?.years ?? []).map((y) => (
              <View key={y.year} style={{ marginBottom: spacing.lg }}>
                <TouchableOpacity
                  testID={`year-${y.year}`}
                  onPress={() => setExpanded({ ...expanded, [y.year]: !expanded[y.year] })}
                  style={styles.yearRow}
                >
                  <Text style={styles.yearText}>{y.year}</Text>
                  <Ionicons
                    name={expanded[y.year] === false ? "chevron-forward" : "chevron-down"}
                    size={20}
                    color={colors.muted}
                  />
                </TouchableOpacity>
                {expanded[y.year] !== false &&
                  y.months.map((m) => (
                    <TouchableOpacity
                      key={m.month}
                      testID={`month-${y.year}-${m.month}`}
                      onPress={() =>
                        router.push({
                          pathname: "/pazienti/[id]/mese/[year]/[month]",
                          params: {
                            id: p.id,
                            year: String(y.year),
                            month: String(m.month),
                          },
                        })
                      }
                      style={styles.monthRow}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.monthName}>{m.month_label}</Text>
                        <Text style={styles.monthMeta}>
                          {m.count} sedute · {m.hours}h · {euro(m.amount)}
                        </Text>
                      </View>
                      {m.invoice_number_full ? (
                        <View style={styles.invoicedPill}>
                          <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                          <Text style={styles.invoicedText}>{m.invoice_number_full}</Text>
                        </View>
                      ) : (
                        <View style={styles.ctaPill}>
                          <Text style={styles.ctaPillText}>Crea fattura</Text>
                        </View>
                      )}
                      <Ionicons name="chevron-forward" size={18} color={colors.muted} />
                    </TouchableOpacity>
                  ))}
              </View>
            ))
          )}

          <TouchableOpacity
            testID="delete-patient"
            style={styles.deleteBtn}
            onPress={() =>
              Alert.alert(
                "Eliminare paziente?",
                "Verranno rimosse anche tutte le terapie. Le fatture emesse restano archiviate.",
                [
                  { text: "Annulla", style: "cancel" },
                  {
                    text: "Elimina",
                    style: "destructive",
                    onPress: () => del.mutate(),
                  },
                ],
              )
            }
          >
            <Ionicons name="trash" size={16} color={colors.error} />
            <Text style={styles.deleteText}>Elimina paziente</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

function KPI({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    backgroundColor: colors.brandTertiary,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  headerRow: { flexDirection: "row", alignItems: "center" },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarWrap: { alignItems: "center", marginTop: spacing.md },
  avatarLg: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  avatarLgText: { color: colors.onBrandPrimary, fontSize: 26, fontWeight: "800" },
  name: { fontSize: 22, fontWeight: "800", color: colors.onSurface },
  subtle: { color: colors.onBrandTertiary, marginTop: 4, fontSize: 12 },
  hcpBadge: {
    marginTop: spacing.sm,
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  hcpBadgeText: { color: colors.onBrandPrimary, fontSize: 11, fontWeight: "700" },

  kpiRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  kpi: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: 12 },
  kpiValue: { fontSize: 16, fontWeight: "800", color: colors.onSurface },
  kpiLabel: { fontSize: 11, color: colors.muted, marginTop: 2 },

  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: spacing.md,
    marginLeft: spacing.sm,
  },
  empty: { alignItems: "center", padding: spacing.xl },
  emptyText: { color: colors.muted, marginTop: 8 },

  yearRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    marginBottom: spacing.sm,
  },
  yearText: { flex: 1, fontSize: 20, fontWeight: "800", color: colors.onSurface },
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    gap: 8,
  },
  monthName: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  monthMeta: { fontSize: 12, color: colors.muted, marginTop: 2 },
  invoicedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.brandTertiary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  invoicedText: { color: colors.success, fontSize: 12, fontWeight: "700" },
  ctaPill: {
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  ctaPillText: { color: colors.onBrandPrimary, fontSize: 12, fontWeight: "700" },

  deleteBtn: {
    marginTop: spacing.xl,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.error,
  },
  deleteText: { color: colors.error, fontWeight: "700" },
});
