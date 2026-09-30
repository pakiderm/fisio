# FisioManager — App Fisioterapista (con login)

## Cosa fa
App mobile personale in italiano per fisioterapista. I dati sono salvati sul tuo profilo protetto da login (email/password, Google o Apple). Il calendario è la fonte unica dei dati: durante il mese si inseriscono le terapie e a fine mese l'app genera la fattura Excel/PDF con la data di emissione scelta da te.

## Autenticazione (3 metodi)
- **Email + Password** (registrazione con nome/cognome, minimo 6 caratteri)
- **Google** (un tap, gestito da Emergent Auth)
- **Apple** (iOS reale, verifica firma JWT contro le chiavi Apple)
Ogni utente vede SOLO i propri dati (pazienti, appuntamenti, fatture, impostazioni). Numerazione fattura indipendente per utente. Logout da Impostazioni.

## Sezioni principali (bottom tabs)
- **Calendario** — Giorno/Settimana/Mese, FAB "+", pulsante microfono per assistente vocale AI
- **Pazienti** — rubrica con ricerca; scheda con storico Anno → Mese → Terapie
- **Fatture** — archivio con filtri (anno, mese, paziente), condivisione file
- **Impostazioni** — tariffa, prossimo numero, bollo, dati professionali, sezione Account con logout

## Fattura
Prima della conferma appare l'**anteprima** con numero progressivo, paziente, ore, importi e — nuovo — **Data di emissione modificabile** (tocca per aprire il selettore giorno/mese/anno). Il file Excel viene generato dal template originale fedelmente (openpyxl), il PDF aggiunge la stessa struttura per lettura rapida (reportlab). Snapshot dei dati alla conferma, blocco doppia fatturazione, avanzamento contatore solo alla conferma.

## Assistente vocale AI (ChatGPT gpt-5.4 + OpenAI STT)
Nel calendario, tap sul microfono → parla in italiano. Riconosce:
- "Prossimo lunedì alle 9 metti Maria Rossi per un'ora e mezza"
- "Domani cancella l'appuntamento delle 10"
- "Copia la settimana scorsa a questa settimana"

## Backend
- FastAPI + MongoDB, tutti gli endpoint sotto `/api`
- Auth: bcrypt per password, session_token bearer, upsert dell'utente per email
- Excel/PDF: openpyxl + reportlab; issue_date scelto dall'utente
- AI: emergentintegrations (LlmChat gpt-5.4 + OpenAISpeechToText)
- **33/33 test backend passati** (auth + isolamento + bug fix + issue_date)

## Come si usa a fine mese
Pazienti → paziente → Anno → Mese → controlla Anteprima → **Data di emissione** (opzionale) → **Conferma e crea fattura**. Il file Excel viene generato con il numero progressivo e archiviato.
