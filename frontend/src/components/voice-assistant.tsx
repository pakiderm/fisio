import Ionicons from "@react-native-vector-icons/ionicons";
import { useQueryClient } from "@tanstack/react-query";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { API, api } from "@/src/api";
import { toISODate } from "@/src/format";
import { colors, radius, spacing } from "@/src/theme";

type Phase = "idle" | "listening" | "transcribing" | "planning" | "done";

interface PlanResult {
  ok: boolean;
  op: string;
  summary?: string;
  error?: string;
}

interface PlanResponse {
  text: string;
  understood: string;
  actions: any[];
  results: PlanResult[];
}

export function VoiceAssistant({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const state = useAudioRecorderState(recorder, 200);
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState<string>("");
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string>("");
  const preparingRef = useRef(false);

  useEffect(() => {
    // Pre-warm audio mode on mount
    setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!visible) {
      setPhase("idle");
      setText("");
      setPlan(null);
      setError("");
    }
  }, [visible]);

  const start = async () => {
    if (preparingRef.current || phase !== "idle") return;
    setError("");
    setPlan(null);
    setText("");
    preparingRef.current = true;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError("Serve il permesso microfono per usare l'assistente vocale.");
        preparingRef.current = false;
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setPhase("listening");
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      preparingRef.current = false;
    }
  };

  const stopAndSend = async () => {
    if (phase !== "listening") return;
    setPhase("transcribing");
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error("Registrazione vuota");
      // Upload
      const form = new FormData();
      form.append("audio", {
        // @ts-ignore RN FormData part
        uri,
        name: "voice.m4a",
        type: "audio/m4a",
      });
      const trRes = await fetch(`${API}/voice/transcribe`, {
        method: "POST",
        body: form as any,
      });
      if (!trRes.ok) throw new Error(`Trascrizione fallita (${trRes.status})`);
      const trJson = (await trRes.json()) as { text: string };
      const heard = (trJson.text || "").trim();
      setText(heard);
      if (!heard) {
        setError("Non ho sentito nulla. Riprova.");
        setPhase("idle");
        return;
      }
      setPhase("planning");
      const p = await api.post<PlanResponse>("/voice/plan", {
        text: heard,
        today: toISODate(new Date()),
      });
      setPlan(p);
      setPhase("done");
      qc.invalidateQueries({ queryKey: ["appointments"] });
      qc.invalidateQueries({ queryKey: ["history"] });
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase("idle");
    }
  };

  const cancel = async () => {
    try {
      if (state.isRecording) await recorder.stop();
    } catch {}
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={cancel}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { paddingBottom: (insets.bottom || 0) + spacing.lg }]}>
          <View style={styles.dragBar} />
          <View style={styles.headerRow}>
            <Text style={styles.title}>Assistente vocale</Text>
            <TouchableOpacity onPress={cancel} testID="voice-close">
              <Ionicons name="close" size={24} color={colors.muted} />
            </TouchableOpacity>
          </View>

          <Text style={styles.hint}>
            Es. “Prossimo lunedì alle 9 metti Maria Arienzo per un'ora e mezza”, “Domani cancella l'appuntamento delle 10”, “Copia la settimana scorsa a questa settimana”.
          </Text>

          {/* Mic */}
          <View style={styles.micWrap}>
            {phase === "idle" && (
              <TouchableOpacity
                testID="voice-start"
                onPress={start}
                style={[styles.micBtn, { backgroundColor: colors.brandPrimary }]}
              >
                <Ionicons name="mic" size={44} color={colors.onBrandPrimary} />
              </TouchableOpacity>
            )}
            {phase === "listening" && (
              <TouchableOpacity
                testID="voice-stop"
                onPress={stopAndSend}
                style={[styles.micBtn, { backgroundColor: colors.error }]}
              >
                <Ionicons name="stop" size={44} color={colors.onError} />
              </TouchableOpacity>
            )}
            {(phase === "transcribing" || phase === "planning") && (
              <View style={[styles.micBtn, { backgroundColor: colors.brandSecondary }]}>
                <ActivityIndicator size="large" color={colors.brandPrimary} />
              </View>
            )}
            {phase === "done" && (
              <TouchableOpacity
                testID="voice-again"
                onPress={() => {
                  setPhase("idle");
                  setText("");
                  setPlan(null);
                }}
                style={[styles.micBtn, { backgroundColor: colors.brandPrimary }]}
              >
                <Ionicons name="mic" size={44} color={colors.onBrandPrimary} />
              </TouchableOpacity>
            )}
          </View>

          <Text style={styles.phaseText}>
            {phase === "idle" && "Tocca per parlare"}
            {phase === "listening" && "In ascolto… tocca per inviare"}
            {phase === "transcribing" && "Trascrizione…"}
            {phase === "planning" && "Elaborazione…"}
            {phase === "done" && "Fatto"}
          </Text>

          <ScrollView style={styles.output}>
            {!!text && (
              <View style={styles.bubble}>
                <Text style={styles.bubbleLabel}>Hai detto</Text>
                <Text style={styles.bubbleText}>{text}</Text>
              </View>
            )}
            {!!plan?.understood && (
              <View style={[styles.bubble, { backgroundColor: colors.brandTertiary }]}>
                <Text style={styles.bubbleLabel}>Ho capito</Text>
                <Text style={styles.bubbleText}>{plan.understood}</Text>
              </View>
            )}
            {plan?.results?.map((r, i) => (
              <View
                key={i}
                style={[
                  styles.result,
                  {
                    borderLeftColor: r.ok ? colors.success : colors.error,
                  },
                ]}
              >
                <Ionicons
                  name={r.ok ? "checkmark-circle" : "alert-circle"}
                  size={18}
                  color={r.ok ? colors.success : colors.error}
                />
                <Text style={styles.resultText}>{r.summary || r.error || r.op}</Text>
              </View>
            ))}
            {!!error && (
              <View style={[styles.result, { borderLeftColor: colors.error }]}>
                <Ionicons name="alert-circle" size={18} color={colors.error} />
                <Text style={styles.resultText}>{error}</Text>
              </View>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  card: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    maxHeight: "88%",
  },
  dragBar: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.md,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.onSurface },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  micWrap: { alignItems: "center", marginVertical: spacing.xl },
  micBtn: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
  },
  phaseText: {
    textAlign: "center",
    color: colors.onSurfaceSecondary,
    fontSize: 14,
    fontWeight: "600",
    marginBottom: spacing.md,
  },
  output: { maxHeight: 260 },
  bubble: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  bubbleLabel: { color: colors.muted, fontSize: 11, fontWeight: "700", textTransform: "uppercase" },
  bubbleText: { color: colors.onSurface, fontSize: 15, marginTop: 4 },
  result: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
  },
  resultText: { flex: 1, color: colors.onSurface, fontSize: 14 },
});
