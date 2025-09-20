// netlify/functions/submit-form.js

const { google } = require('googleapis');
const axios = require('axios');

// AWeber OAuth2
const AWEBER_CLIENT_ID = process.env.AWEBER_CLIENT_ID;
const AWEBER_CLIENT_SECRET = process.env.AWEBER_CLIENT_SECRET;
const AWEBER_REFRESH_TOKEN = process.env.AWEBER_REFRESH_TOKEN;
const AWEBER_ACCOUNT_ID = process.env.AWEBER_ACCOUNT_ID;
const AWEBER_LIST_ID = process.env.AWEBER_LIST_ID;

// Google Sheets
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    const data = JSON.parse(event.body);
    
    // Valida i dati
    if (!data.nome_completo || !data.email || !data.telefono) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Tutti i campi sono obbligatori' })
      };
    }

    // 1. Salva su Google Sheets
    await saveToGoogleSheets(data);
    console.log('✅ Salvato su Google Sheets');
    
    // 2. Aggiungi ad AWeber con tag dinamico
    let aweberStatus = 'not_attempted';
    try {
      await addToAWeber(data);
      aweberStatus = 'success';
      console.log('✅ Aggiunto ad AWeber con tag:', data.tag);
    } catch (aweberError) {
      console.warn('⚠️ AWeber error:', aweberError.message);
      aweberStatus = 'failed';
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        message: 'Registrazione completata'
      })
    };

  } catch (error) {
    console.error('Errore:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Errore durante la registrazione',
        details: error.message 
      })
    };
  }
};

// Funzione per salvare su Google Sheets
async function saveToGoogleSheets(data) {
  try {
    const auth = new google.auth.JWT(
      GOOGLE_SERVICE_ACCOUNT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY,
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    const sheets = google.sheets({ version: 'v4', auth });

    // Formatta la data in orario italiano
    const now = new Date();
    
    // Usa direttamente toLocaleString con timezone Europe/Rome
    const dataFormattata = now.toLocaleString('it-IT', {
      timeZone: 'Europe/Rome',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    
    // Estrai numero senza prefisso internazionale
    // Per l'Italia (+39), rimuovi solo "+39" e mantieni tutto il resto
    let phoneWithoutPrefix = data.telefono;
    
    // Rimuovi il prefisso internazionale mantenendo il numero completo
    if (data.telefono.startsWith('+39')) {
      phoneWithoutPrefix = data.telefono.substring(3); // Rimuove "+39"
    } else if (data.telefono.startsWith('+1')) {
      phoneWithoutPrefix = data.telefono.substring(2); // Rimuove "+1"
    } else if (data.telefono.startsWith('+44')) {
      phoneWithoutPrefix = data.telefono.substring(3); // Rimuove "+44"
    } else if (data.telefono.startsWith('+49')) {
      phoneWithoutPrefix = data.telefono.substring(3); // Rimuove "+49"
    } else if (data.telefono.startsWith('+33')) {
      phoneWithoutPrefix = data.telefono.substring(3); // Rimuove "+33"
    } else if (data.telefono.startsWith('+34')) {
      phoneWithoutPrefix = data.telefono.substring(3); // Rimuove "+34"
    } else if (data.telefono.startsWith('+41')) {
      phoneWithoutPrefix = data.telefono.substring(3); // Rimuove "+41"
    } else if (data.telefono.startsWith('+')) {
      // Per altri prefissi, rimuovi il + e fino a 3 cifre
      phoneWithoutPrefix = data.telefono.replace(/^\+\d{1,3}/, '');
    }

    // ===== MODIFICA IMPORTANTE: SOLO FONTI MAPPATE =====
    // Mappa delle fonti - SOLO queste verranno tracciate, tutto il resto sarà "Direct"
    const sourceMap = {
      'mads-3': 'MADS',
      'tg-3': 'TG',
      'igs-3': 'IGS',
      'igb-3': 'IGB',
      'tt-3': 'TT',
      'mail-3': 'MAIL'
      // Aggiungi qui SOLO i percorsi che vuoi tracciare esplicitamente
      // Ad esempio:
      // 'altropercorso': 'AltroNome',
    };

    // IMPORTANTE: Ignora qualsiasi fonte non mappata e usa sempre "Direct"
    const sourceName = sourceMap[data.source] || 'Direct';
    
    // Debug log per vedere cosa sta arrivando
    console.log('Source ricevuta:', data.source, '-> Mappata a:', sourceName);

    // Prepara i dati per lo sheet - SOLO 6 colonne, NO TAG!
    const values = [[
      data.nome_completo,      // Colonna A
      data.email,              // Colonna B
      data.telefono,           // Colonna C
      dataFormattata,          // Colonna D
      sourceName,              // Colonna E (SOLO valori mappati o "Direct")
      phoneWithoutPrefix       // Colonna F
      // RIMOSSO il tag dalla colonna G
    ]];

    // Prima, ottieni l'ultima riga con dati per copiare la formattazione
    const rangeResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'A:F',
    });

    const existingRows = rangeResponse.data.values || [];
    const lastRowNumber = existingRows.length;

    // Inserisci i dati
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'A:F',  // Solo colonne A-F, non G
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });

    // Copia la formattazione dalla riga precedente alla nuova riga
    if (lastRowNumber > 1) {
      const newRowNumber = lastRowNumber + 1;
      
      // Copia formato dalla riga precedente
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: {
          requests: [
            {
              copyPaste: {
                source: {
                  sheetId: 0,  // Assume il primo foglio
                  startRowIndex: lastRowNumber - 1,
                  endRowIndex: lastRowNumber,
                  startColumnIndex: 0,
                  endColumnIndex: 6  // Colonne A-F
                },
                destination: {
                  sheetId: 0,
                  startRowIndex: newRowNumber - 1,
                  endRowIndex: newRowNumber,
                  startColumnIndex: 0,
                  endColumnIndex: 6
                },
                pasteType: 'PASTE_FORMAT'  // Copia solo la formattazione, non i valori
              }
            }
          ]
        }
      });
    }

  } catch (error) {
    console.error('Errore Google Sheets:', error);
    throw new Error('Impossibile salvare su Google Sheets');
  }
}

// Funzione per AWeber access token
async function getAWeberAccessToken() {
  try {
    const response = await axios.post('https://auth.aweber.com/oauth2/token', {
      grant_type: 'refresh_token',
      refresh_token: AWEBER_REFRESH_TOKEN,
      client_id: AWEBER_CLIENT_ID,
      client_secret: AWEBER_CLIENT_SECRET
    });

    return response.data.access_token;
  } catch (error) {
    console.error('Errore token AWeber:', error);
    throw new Error('Impossibile autenticarsi con AWeber');
  }
}

// Funzione per aggiungere ad AWeber
async function addToAWeber(data) {
  try {
    const accessToken = await getAWeberAccessToken();

    // Usa il tag dinamico passato dal form
    const tagName = data.tag || 'leads-default';

    const subscriberData = {
      email: data.email,
      name: data.nome_completo,
      custom_fields: {
        phone: data.telefono
      },
      tags: [tagName],
      update_existing: true
    };

    const response = await axios.post(
      `https://api.aweber.com/1.0/accounts/${AWEBER_ACCOUNT_ID}/lists/${AWEBER_LIST_ID}/subscribers`,
      subscriberData,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('Aggiunto ad AWeber con tag:', tagName);
    
  } catch (error) {
    if (error.response && error.response.status === 400) {
      console.log('Subscriber esistente, provo ad aggiornare...');
      
      try {
        const accessToken = await getAWeberAccessToken();
        
        const searchResponse = await axios.get(
          `https://api.aweber.com/1.0/accounts/${AWEBER_ACCOUNT_ID}/lists/${AWEBER_LIST_ID}/subscribers`,
          {
            params: { 
              'email': data.email,
              'ws.op': 'find'
            },
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          }
        );

        if (searchResponse.data.entries && searchResponse.data.entries.length > 0) {
          const subscriber = searchResponse.data.entries[0];
          
          // Aggiungi il tag dinamico
          await axios.post(
            `${subscriber.self_link}/tags`,
            { 
              name: data.tag || 'leads-default'
            },
            {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              }
            }
          );
          
          console.log('Tag aggiunto al subscriber esistente');
        }
      } catch (updateError) {
        console.error('Errore aggiornamento:', updateError);
      }
    } else {
      throw error;
    }
  }
}