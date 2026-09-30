import Ionicons from "@react-native-vector-icons/ionicons";
import { useQuery } from "@tanstack/react-query";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, downloadUrl } from "@/src/api";
import { MONTHS_IT, euro, fmtDayShort } from "@/src/format";
import { colors, radius, spacing } from "@/src/theme";
import type { Invoice, Patient } from "@/src/types";

export default function InvoicesScreen() {
  const insets = useSafeAreaInsets();
  const [year, setYear] = useState<number | undefined>(undefined);
  const [month, setMonth] = useState<number | undefined>(undefined);
  const [patientId, setPatientId] = useState<string | undefined>(undefined);

  const invoicesQ = useQuery({
    queryKey: ["invoices", year, month, patientId],
    queryFn: () =>
      api.get<Invoice[]>("/invoices", {
        year,
        month,
        patient_id: patientId,
      }),
  });
  const patientsQ = useQuery({
    queryKey: ["patients"],
    queryFn: () => api.get<Patient[]>("/patients"),
  });

  const years = useMemo(() => {
    const s = new Set<number>();
    (invoicesQ.data ?? []).forEach((i) => s.add(i.year));
    return Array.from(s).sort((a, b) => b - a);
  }, [invoicesQ.data]);

  const patientLabel = (id: string) => {
    const p = (patientsQ.data ?? []).find((x) => x.id === id);
    return p ? `${p.last_name} ${p.first_name}` : "—";
  };

  const openInvoice = async (inv: Invoice, fmt: "xlsx" | "pdf") => {
    const url = downloadUrl(inv.id, fmt);
    if (Platform.OS === "web") {
      window.open(url, "_blank");
      return;
    }
    try {
      const name = `fattura_${inv.number}_${inv.year}_${String(inv.month).padStart(2, "0")}.${fmt}`;
      const target = `${FileSystem.cacheDirectory}${name}`;
      const res = await FileSystem.downloadAsync(url, target);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, {
          mimeType:
            fmt === "xlsx"
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : "application/pdf",
          dialogTitle: `Fattura ${inv.number_full}`,
          UTI: fmt === "xlsx" ? "org.openxmlformats.spreadsheetml.sheet" : "com.adobe.pdf",
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Fatture</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.lg }}
          style={{ marginTop: spacing.sm }}
        >
          <Chip
            label="Tutti gli anni"
            active={year === undefined}
            onPress={() => setYear(undefined)}
            testID="filter-year-all"
          />
          {years.map((y) => (
            <Chip
              key={y}
              label={String(y)}
              active={year === y}
              onPress={() => setYear(year === y ? undefined : y)}
              testID={`filter-year-${y}`}
            />
          ))}
        </ScrollView>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.lg }}
          style={{ marginTop: spacing.sm }}
        >
          <Chip
            label="Tutti i mesi"
            active={month === undefined}
            onPress={() => setMonth(undefined)}
            testID="filter-month-all"
          />
          {MONTHS_IT.map((m, i) => (
            <Chip
              key={m}
              label={m}
              active={month === i + 1}
              onPress={() => setMonth(month === i + 1 ? undefined : i + 1)}
              testID={`filter-month-${i + 1}`}
            />
          ))}
        </ScrollView>
        {(patientsQ.data?.length ?? 0) > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.lg }}
            style={{ marginTop: spacing.sm }}
          >
            <Chip
              label="Tutti i pazienti"
              active={patientId === undefined}
              onPress={() => setPatientId(undefined)}
              testID="filter-patient-all"
            />
            {(patientsQ.data ?? []).map((p) => (
              <Chip
                key={p.id}
                label={`${p.last_name} ${p.first_name}`}
                active={patientId === p.id}
                onPress={() => setPatientId(patientId === p.id ? undefined : p.id)}
                testID={`filter-patient-${p.id}`}
              />
            ))}
          </ScrollView>
        )}
      </View>

      {invoicesQ.isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : (invoicesQ.data ?? []).length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="document-text-outline" size={56} color={colors.muted} />
          <Text style={styles.emptyTitle}>Nessuna fattura emessa</Text>
          <Text style={styles.emptySub}>
            Genera la prima fattura dalla scheda di un paziente.
          </Text>
        </View>
      ) : (
        <FlatList
          data={invoicesQ.data ?? []}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120 }}
          renderItem={({ item }) => (
            <View style={styles.card} testID={`invoice-${item.id}`}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{item.number_full}</Text>
                </View>
                <Text style={styles.cardAmount}>{euro(item.total)}</Text>
              </View>
              <Text style={styles.cardName}>{patientLabel(item.patient_id)}</Text>
              <Text style={styles.cardMeta}>
                {MONTHS_IT[item.month - 1]} {item.year} · emessa il {fmtDayShort(item.issue_date)}
              </Text>
              <View style={styles.actions}>
                <TouchableOpacity
                  testID={`open-xlsx-${item.id}`}
                  style={styles.actionBtn}
                  onPress={() => openInvoice(item, "xlsx")}
                >
                  <Ionicons name="document" size={16} color={colors.brandPrimary} />
                  <Text style={styles.actionText}>Excel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID={`open-pdf-${item.id}`}
                  style={styles.actionBtn}
                  onPress={() => openInvoice(item, "pdf")}
                >
                  <Ionicons name="document-text" size={16} color={colors.brandPrimary} />
                  <Text style={styles.actionText}>PDF</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
        />
      )}
    </View>
  );
}

function Chip({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      style={[
        styles.chip,
        active && {
          backgroundColor: colors.brandPrimary,
          borderColor: colors.brandPrimary,
        },
      ]}
    >
      <Text
        style={[
          styles.chipText,
          active && { color: colors.onBrandPrimary, fontWeight: "700" },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, paddingTop: spacing.sm },
  title: { fontSize: 28, fontWeight: "800", color: colors.onSurface },
  chip: {
    height: 34,
    minWidth: 60,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chipText: { fontSize: 13, color: colors.onSurface },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.lg },
  emptyTitle: { fontSize: 18, color: colors.onSurface, fontWeight: "700", marginTop: 12 },
  emptySub: { color: colors.muted, marginTop: 4, textAlign: "center" },

  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  badge: {
    backgroundColor: colors.brandTertiary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  badgeText: { color: colors.onBrandTertiary, fontWeight: "700", fontSize: 12 },
  cardAmount: {
    marginLeft: "auto",
    fontSize: 18,
    fontWeight: "800",
    color: colors.brandPrimary,
  },
  cardName: {
    marginTop: spacing.sm,
    fontSize: 16,
    fontWeight: "700",
    color: colors.onSurface,
  },
  cardMeta: { color: colors.muted, fontSize: 12, marginTop: 2 },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.brandSecondary,
  },
  actionText: { color: colors.brandPrimary, fontWeight: "700", fontSize: 13 },
});
