import axios from "axios";
import WebSocket from "ws";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { Connection } from "@solana/web3.js";
import { DateTime } from "luxon";

// 🔹 Configuración
const TELEGRAM_BOT_TOKEN = "8167837961:AAFipBvWbQtFWHV_uZt1lmG4CVVnc_z8qJU";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const SUBSCRIBERS_FILE = "subscribers.json";
const RUGCHECK_API_BASE = "https://api.rugcheck.xyz/v1/tokens";
const connection = new Connection(SOLANA_RPC_URL, "confirmed");

const INSTANTNODES_WS_URL = "wss://mainnet.helius-rpc.com/?api-key=0c964f01-0302-4d00-a86c-f389f87a3f35";
const MIGRATION_PROGRAM_ID = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const LOG_FILE = "transactions.log";

let ws;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let subscribers = new Set();

// 🔥 Cargar suscriptores desde el archivo JSON
function loadSubscribers() {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
        try {
            const data = fs.readFileSync(SUBSCRIBERS_FILE, "utf8");
            subscribers = new Set(JSON.parse(data));
            console.log(`✅ ${subscribers.size} usuarios suscritos cargados.`);
        } catch (error) {
            console.error("❌ Error cargando suscriptores:", error);
        }
    }
}

// 📝 Guardar suscriptores en el archivo JSON
function saveSubscribers() {
    try {
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...subscribers], null, 2));
        console.log("📂 Subscriptores actualizados.");
    } catch (error) {
        console.error("❌ Error guardando suscriptores:", error);
    }
}

// 🔹 Comando `/start` para suscribirse a notificaciones
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!subscribers.has(chatId)) {
        subscribers.add(chatId);
        saveSubscribers();
        bot.sendMessage(chatId, "🚀 Te has suscrito a las notificaciones de migraciones en Solana.");
    } else {
        bot.sendMessage(chatId, "⚠️ Ya estás suscrito.");
    }
});

// 🔹 Comando `/stop` para cancelar suscripción
bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (subscribers.has(chatId)) {
        subscribers.delete(chatId);
        saveSubscribers();
        bot.sendMessage(chatId, "🛑 Has sido eliminado de las notificaciones.");
    } else {
        bot.sendMessage(chatId, "⚠️ No estabas suscrito.");
    }
});

// 🔹 Conexión WebSocket con reconexión automática
function connectWebSocket() {
    if (ws) {
        ws.removeAllListeners();
    }

    ws = new WebSocket(INSTANTNODES_WS_URL);

    ws.on("open", () => {
        console.log("✅ Conectado al WebSocket de InstantNodes");

        const subscribeMessage = {
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
                { mentions: [MIGRATION_PROGRAM_ID] },
                { commitment: "finalized" }
            ]
        };

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(subscribeMessage));
        }
    });

    ws.on("message", (data) => {
        try {
            const transaction = JSON.parse(data);
            if (transaction) {
                processTransaction(transaction);
            }
        } catch (error) {
            console.error("❌ Error al procesar el mensaje:", error);
        }
    });

    ws.on("close", (code, reason) => {
        console.warn(`⚠️ Conexión cerrada (Código: ${code}, Razón: ${reason || "Desconocida"})`);
        setTimeout(() => {
            console.log("🔄 Intentando reconectar...");
            connectWebSocket();
        }, 5000);
    });

    ws.on("error", (error) => {
        console.error("❌ Error en WebSocket:", error);
    });

    // 💓 Mantener conexión viva
    ws.on("pong", () => {
        console.log("💓 Recibido PONG desde el servidor.");
    });
}

// 🔥 Cargar suscriptores antes de iniciar el WebSocket y Heartbeat
loadSubscribers();
connectWebSocket();

// 💓 Mantener la conexión activa enviando ping cada 30s
function startHeartbeat() {
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.ping(); // 🔥 Ahora usa `ping()` en lugar de `ws.send("ping")`
            console.log("💓 Enviando ping al WebSocket");
        }
    }, 30000);
}

startHeartbeat();

// ⏳ Configuración del tiempo de espera antes de ejecutar el análisis
let DELAY_BEFORE_ANALYSIS = 30 * 1000; // 30 segundos por defecto

// 🔹 Comando `/delay X` para cambiar el tiempo de espera dinámicamente
bot.onText(/\/delay (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const newDelay = parseInt(match[1]);

    if (isNaN(newDelay) || newDelay < 10 || newDelay > 300) {
        bot.sendMessage(chatId, "⚠️ *Tiempo inválido.* Introduce un número entre 10 y 300 segundos.", { parse_mode: "Markdown" });
        return;
    }

    DELAY_BEFORE_ANALYSIS = newDelay * 1000;
    bot.sendMessage(chatId, `⏳ *Nuevo tiempo de espera configurado:* ${newDelay} segundos.`, { parse_mode: "Markdown" });

    console.log(`🔧 Delay actualizado a ${newDelay} segundos por el usuario.`);
});

// 🔹 Procesar transacciones WebSocket y ejecutar análisis después de un delay
function processTransaction(transaction) {
    try {
        const logs = transaction?.params?.result?.value?.logs || [];
        const signature = transaction?.params?.result?.value?.signature;

        if (!logs.length || !signature) return;

        if (logs.some(log => log.includes("Program log: Create"))) {
            console.log(`📌 Transacción detectada: ${signature}`);
            console.log(`⏳ Esperando ${DELAY_BEFORE_ANALYSIS / 1000} segundos antes de ejecutar el análisis...`);

            setTimeout(async () => {
                console.log(`🚀 Ejecutando análisis para la transacción: ${signature}`);
                await analyzeTransaction(signature);
            }, DELAY_BEFORE_ANALYSIS);
        }
    } catch (error) {
        console.error("❌ Error en processTransaction:", error);
    }
}

// 🔹 Obtener Mint Address desde una transacción en Solana
async function getMintAddressFromTransaction(signature) {
    try {
        const transaction = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
        });

        if (!transaction || !transaction.meta || !transaction.meta.preTokenBalances) {
            console.error("❌ No se pudo obtener la transacción.");
            return null;
        }

        const status = transaction.meta?.err ? "Failed ❌" : "Confirmed ✅";

        const dateEST = DateTime.fromSeconds(transaction.blockTime)
            .setZone("America/New_York")
            .toFormat("MM/dd/yyyy HH:mm:ss 'EST'");

        return {
            mintAddress: transaction.meta?.preTokenBalances?.[0]?.mint || "N/A",
            date: dateEST,
            status: status
        };
    } catch (error) {
        console.error("❌ Error al obtener Mint Address:", error);
        return null;
    }
}

function escapeMarkdown(text) {
    if (typeof text !== "string") {
        return String(text || "N/A"); // Asegurar que siempre sea string
    }

    return text
        .replace(/_/g, "\\_")
        .replace(/\*/g, "\\*")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)")
        .replace(/~/g, "\\~")
        .replace(/`/g, "\\`")
        .replace(/>/g, "\\>")
        .replace(/#/g, "\\#")
        // 🔥 Eliminamos el escape de `+` y `-` para evitar `\+` y `\-`
        .replace(/=/g, "\\=")
        .replace(/\|/g, "\\|")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")
        .replace(/!/g, "\\!");
}

// 🔹 Calcular la diferencia en segundos para "Graduations"
function calculateGraduations(migrationDate, age) {
    try {
        const migrationDateTime = DateTime.fromFormat(migrationDate, "MM/dd/yyyy HH:mm:ss 'EST'", { zone: "America/New_York" });

        // Extraer horas, minutos y segundos correctamente
        const ageParts = age.match(/(?:(\d+)h )?(\d+)m (\d+)s/);
        if (!ageParts) return "N/A";

        const hours = ageParts[1] ? parseInt(ageParts[1], 10) : 0;
        const minutes = parseInt(ageParts[2], 10);
        const seconds = parseInt(ageParts[3], 10);

        // Calcular la fecha final sumando la edad al tiempo de migración
        const finalTime = migrationDateTime.plus({ hours, minutes, seconds });

        // Obtener la diferencia con el tiempo actual en EST
        const nowEST = DateTime.now().setZone("America/New_York");
        const diffSeconds = Math.abs(Math.round(nowEST.diff(finalTime, "seconds").seconds)); // Redondea a número entero

        return `${diffSeconds} Seg`;
    } catch (error) {
        console.error("❌ Error calculando Graduations:", error);
        return "N/A";
    }
}

// 🔹 Obtener datos desde DexScreener hasta que `dexId` sea `"raydium"`
async function getDexScreenerData(mintAddress) {
    let dexData = null;
    
    console.log(`🔄 Buscando en DexScreener para: ${mintAddress}`);
    
    while (!dexData || dexData.dexId !== "raydium") {
        try {
            const response = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${mintAddress}`);
            if (response.data && response.data.length > 0) {
                dexData = response.data[0];
                console.log(`🔍 Obteniendo datos... DexID: ${dexData.dexId}`);
            }
        } catch (error) {
            console.error("⚠️ Error en DexScreener:", error.message);
        }

        if (!dexData || dexData.dexId !== "raydium") {
            console.log("⏳ Esperando 1 segundo para volver a intentar...");
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    console.log("✅ DexScreener confirmado en Raydium.");

    return {
        name: dexData.baseToken?.name || "Desconocido",
        symbol: dexData.baseToken?.symbol || "N/A",
        priceUsd: dexData.priceUsd || "N/A",
        priceSol: dexData.priceNative || "N/A",
        liquidity: dexData.liquidity?.usd || "N/A",
        marketCap: dexData.marketCap || "N/A",
        fdv: dexData.fdv || "N/A",
        pairAddress: dexData.pairAddress || "N/A",
        dex: dexData.dexId || "N/A",
        chain: dexData.chainId || "solana",
        creationTimestamp: dexData.pairCreatedAt || null,
        priceChange24h: dexData.priceChange?.h24 || "N/A",
        volume24h: dexData.volume?.h24 || "N/A",
        buys24h: dexData.txns?.h24?.buys || "N/A",
        sells24h: dexData.txns?.h24?.sells || "N/A",
        website: dexData.info?.websites?.[0]?.url || "N/A"
    };
}

// 🔹 Obtener datos de riesgo desde RugCheck API
async function fetchRugCheckData(tokenAddress) {
    try {
        const response = await axios.get(`${RUGCHECK_API_BASE}/${tokenAddress}/report`);
        if (!response.data) {
            return null;
        }

        const data = response.data;
        const name = data.fileMeta?.name || "N/A";
        const symbol = data.fileMeta?.symbol || "N/A";
        const imageUrl = data.fileMeta?.image || "";
        const riskScore = data.score || 9999;
        const riskLevel = riskScore <= 1000 ? "🟢 GOOD" : "🔴 WARNING";
        const riskDescription = data.risks?.map(r => r.description).join(", ") || "No risks detected";
        let lpLocked = "N/A";

        if (data.markets && data.markets.length > 0) {
            lpLocked = data.markets[0].lp?.lpLockedPct || "N/A";
        }

        return { name, symbol, imageUrl, riskLevel, riskDescription, lpLocked };
    } catch (error) {
        console.error("❌ Error al obtener datos desde RugCheck:", error);
        return null;
    }
}

// 🔹 Calcular el tiempo desde la creación del par en horas, minutos y segundos
function calculateAge(timestamp) {
    if (!timestamp) return "N/A";
    const now = Date.now();
    const elapsedMs = now - timestamp;

    const hours = Math.floor(elapsedMs / 3600000); // 1 hora = 3600000 ms
    const minutes = Math.floor((elapsedMs % 3600000) / 60000);
    const seconds = Math.floor((elapsedMs % 60000) / 1000);

    if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`; // Si hay horas, las mostramos
    } else {
        return `${minutes}m ${seconds}s`; // Si no hay horas, solo minutos y segundos
    }
}

// 🔹 Conjunto para almacenar firmas ya procesadas
const processedSignatures = new Set();

// 🔹 Función principal que ejecuta todo el proceso
async function analyzeTransaction(signature, fromTelegram = false) {
    console.log(`🔍 Analizando transacción: ${signature}`);

    // 🛑 Verificar si la firma ya fue procesada (solo si NO es de Telegram)
    if (!fromTelegram && processedSignatures.has(signature)) {
        console.log(`⏩ Transacción ignorada: Firma duplicada (${signature})`);
        return;
    }

    // 📌 Agregar la firma al conjunto de procesadas (excepto si viene de Telegram)
    if (!fromTelegram) {
        processedSignatures.add(signature);
    }

    // 1️⃣ Obtener datos del Mint Address desde Solana
    const mintData = await getMintAddressFromTransaction(signature);
    if (!mintData || !mintData.mintAddress) {
        console.log("⚠️ No se pudo obtener el Mint Address.");
        return;
    }

    // 🛑 Filtrar transacciones que no deben procesarse (Wrapped SOL)
    if (mintData.mintAddress === "So11111111111111111111111111111111111111112") {
        console.log("⏩ Transacción ignorada: Wrapped SOL detectado.");
        return;
    }

    console.log(`✅ Mint Address obtenido: ${mintData.mintAddress}`);

    // 2️⃣ Obtener datos de DexScreener (esperando hasta que el dexId sea "raydium")
    const dexData = await getDexScreenerData(mintData.mintAddress);
    if (!dexData) {
        console.log(`⚠️ No se pudo obtener información de DexScreener para ${mintData.mintAddress}`);
        return;
    }
    console.log(`✅ Datos de DexScreener obtenidos para ${mintData.mintAddress}`);

    // 3️⃣ Obtener datos de RugCheck API
    const rugCheckData = await fetchRugCheckData(mintData.mintAddress);
    if (!rugCheckData) {
        console.log(`⚠️ No se pudo obtener información de RugCheck para ${mintData.mintAddress}`);
        return;
    }
    console.log(`✅ Datos de RugCheck obtenidos para ${mintData.mintAddress}`);

    // 4️⃣ Calcular los valores adicionales
    const priceChange24h = dexData.priceChange24h !== "N/A"
        ? `${dexData.priceChange24h > 0 ? "🟢 +" : "🔴 "}${dexData.priceChange24h}%`
        : "N/A";
}

    const age = calculateAge(dexData.creationTimestamp) || "N/A";
    const graduations = calculateGraduations(mintData.date, age) || "N/A";

    // 5️⃣ Formatear mensaje para Telegram
    let message = `💎 **Symbol:** ${escapeMarkdown(String(dexData.symbol))}\n`;
    message += `💎 **Name:** ${escapeMarkdown(String(dexData.name))}\n`;
    message += `💲 **USD:** ${escapeMarkdown(String(dexData.priceUsd))}\n`;
    message += `💰 **SOL:** ${escapeMarkdown(String(dexData.priceSol))}\n`;
    message += `💧 **Liquidity:** $${escapeMarkdown(String(dexData.liquidity))}\n`;
    message += `📈 **Market Cap:** $${escapeMarkdown(String(dexData.marketCap))}\n`;
    message += `💹 **FDV:** $${escapeMarkdown(String(dexData.fdv))}\n\n`;

    message += `⏳ **Age:** ${escapeMarkdown(age)} 📊 **24H:** ${escapeMarkdown(priceChange24h)}\n\n`;

    message += ` **${escapeMarkdown(String(rugCheckData.riskLevel))}:** ${escapeMarkdown(String(rugCheckData.riskDescription))}\n`;
    message += `🔒 **LPLOCKED:** ${escapeMarkdown(String(rugCheckData.lpLocked))}%\n\n`;

    message += `⛓️ **Chain:** ${escapeMarkdown(String(dexData.chain))} ⚡ **Dex:** ${escapeMarkdown(String(dexData.dex))}\n`;
    message += `📆 **Migration Date:** ${escapeMarkdown(String(mintData.date))}\n`;
    message += `🎓 **Graduations:** ${escapeMarkdown(graduations)}\n`;
    message += `🔄 **Status:** ${escapeMarkdown(String(mintData.status))}\n\n`;

    message += `🔗 **Pair:** \`${escapeMarkdown(String(dexData.pairAddress))}\`\n`;
    message += `🔗 **Token:** \`${escapeMarkdown(String(mintData.mintAddress))}\`\n\n`;

    // 6️⃣ Enviar mensaje a los suscriptores en Telegram
    await notifySubscribers(message, rugCheckData.imageUrl, dexData.pairAddress, mintData.mintAddress);
}

// 🔹 Notificar a los suscriptores con imagen y botones
async function notifySubscribers(message, imageUrl, pairAddress, mint) {
    for (const userId of subscribers) {
        try {
            if (imageUrl) {
                // 🔥 Intentar enviar el mensaje con imagen
                await bot.sendPhoto(userId, imageUrl, {
                    caption: message,
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "💸 Buy Token", url: `https://jup.ag/swap/SOL-${mint}` }],
                            [{ text: "📊 Dexscreener", url: `https://dexscreener.com/solana/${pairAddress}` }]
                        ]
                    }
                });
            } else {
                // 🔥 Si no hay imagen, enviar solo el mensaje de texto
                await bot.sendMessage(userId, message, {
                    parse_mode: "Markdown",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "💸 Buy Token", url: `https://jup.ag/swap/SOL-${mint}` }],
                            [{ text: "📊 Dexscreener", url: `https://dexscreener.com/solana/${pairAddress}` }]
                        ]
                    }
                });
            }

            console.log(`✅ Mensaje enviado a ${userId}`);

        } catch (error) {
            console.error(`❌ Error enviando mensaje a ${userId}:`, error);
        }
    }
}

// 🔹 Escuchar firmas enviadas manualmente en Telegram
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (/^[A-HJ-NP-Za-km-z1-9]{87,}$/.test(text)) {
        bot.sendMessage(chatId, "🔄 Consultando transacción...");
        await analyzeTransaction(text, true);  // ✅ Enviamos `true` para forzar la verificación
    } else {
        bot.sendMessage(chatId, "❌ Envía una firma de transacción válida.");
    }
});

// 🔥 Cargar suscriptores al iniciar
loadSubscribers();

console.log("🤖 Bot de Telegram iniciado.");
