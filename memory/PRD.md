# FisioManager — App Fisioterapista

## Cosa fa
App mobile personale (iPhone) in italiano per un fisioterapista. Il calendario è la fonte unica dei dati: si inseriscono le terapie durante il mese e a fine mese l'app genera in automatico la fattura Excel di ogni paziente, seguendo fedelmente il template fornito.

## Sezioni principali (bottom tabs)
- **Calendario** — vista Giorno / Settimana / Mese, FAB "+" per nuovo appuntamento, pulsante microfono per assistente vocale AI
- **Pazienti** — rubrica con ricerca, scheda con storico Anno → Mese → Terapie e badge "Fatturato N/HCP"
- **Fatture** — archivio con filtri (anno, mese, paziente), condivisione file Excel/PDF
- **Impostazioni** — tariffa oraria, prossimo numero fattura, suffisso, bollo, dati professionali

## Funzionalità chiave
- Appuntamenti singoli o **ricorrenti** (settimanale/bi-sett./mensile) con edit "solo questa / da qui in poi / tutta la serie"
- Calcolo automatico durata e importo (tariffa standard 50€/h, oppure tariffa personalizzata per paziente)
- Tre stati per terapia (Programmato / Effettuato / Annullato); le annullate non entrano in fattura
- **Anteprima fattura** con totali, poi conferma. Solo alla conferma il numero viene consumato
- Fattura Excel `.xlsx` generata dal template originale (openpyxl); PDF aggiuntivo (reportlab)
- Anti-doppia-fatturazione: mese già emesso mostra il badge, appuntamenti fatturati sono bloccati per modifica
- Snapshot dei dati alla emissione (paziente/professionista/tariffa/bollo) — modifiche successive non alterano le fatture emesse
- Import base pazienti (endpoint dedicato per liste)

## 🎙️ Assistente vocale AI (ChatGPT gpt-5.4)
Tap sul microfono nel calendario → parla in italiano. Esempi:
- "Prossimo lunedì alle 9 metti Maria Arienzo per un'ora e mezza"
- "Domani cancella l'appuntamento delle 10"
- "Copia la settimana scorsa a questa settimana"
L'AI trascrive con OpenAI Speech-to-Text, interpreta l'intento con GPT-5.4 e crea/cancella/copia gli appuntamenti direttamente.

## Backend
- FastAPI + MongoDB, tutti gli endpoint sotto `/api`
- Excel: `openpyxl` con template fedele (A1..A4 professional, riga 7-11 fattura+paziente, righe 14+ prestazioni con formule `=SUM(A*rate)` e `=IF(G,H$14,0)`, riga 33-36 bollo+totali)
- PDF: `reportlab` con layout equivalente
- AI: `emergentintegrations` (LlmChat, OpenAISpeechToText) con `EMERGENT_LLM_KEY`
- **28/28 test backend passati**

## Come si usa a fine mese
Pazienti → paziente → Anno → Mese → **Crea fattura** → controlla anteprima → **Conferma e crea fattura**. Il file Excel viene generato con il numero progressivo, archiviato, e il contatore avanza.
