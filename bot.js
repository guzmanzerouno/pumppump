import axios from "axios";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";

// 🔹 Configuración
const TELEGRAM_BOT_TOKEN = "TU_BOT_TOKEN";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const SUBSCRIBERS_FILE = "subscribers.json";
const RUGCHECK_API_BASE = "https://api.rugcheck.xyz/v1/tokens";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let subscribers = new Set();

// 🔹 Cargar suscriptores desde archivo
function loadSubscribers() {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
        const data = fs.readFileSync(SUBSCRIBERS_FILE, "utf8");
        subscribers = new Set(JSON.parse(data));
        console.log(`✅ ${subscribers.size} usuarios suscritos cargados.`);
    }
}

// 🔹 Guardar suscriptores en archivo
function saveSubscribers() {
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...subscribers], null, 2));
}

// 🔹 Obtener datos del token desde DexScreener API
async function getDexScreenerData(mintAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${mintAddress}`);
        if (response.data && response.data.length > 0) {
            const tokenData = response.data[0];

            return {
                name: tokenData.baseToken.name || "Desconocido",
                symbol: tokenData.baseToken.symbol || "N/A",
                priceUsd: tokenData.priceUsd || "N/A",
                priceSol: tokenData.priceNative || "N/A",
                liquidity: tokenData.liquidity?.usd || "N/A",
                marketCap: tokenData.marketCap || "N/A",
                fdv: tokenData.fdv || "N/A",
                pairAddress: tokenData.pairAddress || "N/A",
                dex: tokenData.dexId || "N/A",
                chain: tokenData.chainId || "solana",
                creationTimestamp: tokenData.pairCreatedAt || null,
                priceChange24h: tokenData.priceChange?.h24 || "N/A"
            };
        }
    } catch (error) {
        console.error("⚠️ Error al obtener datos desde DexScreener:", error.message);
    }
    return null;
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

// 🔹 Calcular el tiempo desde la creación del par en minutos y segundos
function calculateAge(timestamp) {
    if (!timestamp) return "N/A";
    const now = Date.now();
    const elapsedMs = now - timestamp;
    const minutes = Math.floor(elapsedMs / 60000);
    const seconds = Math.floor((elapsedMs % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

// 🔹 Obtener detalles de la transacción con DexScreener y RugCheck
async function getTransactionDetails(mintAddress) {
    try {
        const dexData = await getDexScreenerData(mintAddress);
        const rugCheckData = await fetchRugCheckData(mintAddress);

        if (!dexData) {
            return `⚠️ No se pudo obtener información del token ${mintAddress}`;
        }

        const priceChange24h = dexData.priceChange24h !== "N/A"
            ? `${dexData.priceChange24h > 0 ? "🟢 +" : "🔴 "}${dexData.priceChange24h}%`
            : "N/A";

        let message = `💎 **Símbolo:** ${dexData.symbol}\n`;
        message += `💎 **Nombre:** ${dexData.name}\n`;
        message += `💲 **USD:** ${dexData.priceUsd}\n`;
        message += `💰 **SOL:** ${dexData.priceSol}\n`;
        message += `💧 **Liquidity:** $${dexData.liquidity}\n`;
        message += `📈 **Market Cap:** $${dexData.marketCap}\n`;
        message += `💹 **FDV:** $${dexData.fdv}\n\n`;
        message += `⏳ **Age:** ${calculateAge(dexData.creationTimestamp)} 📊 **24H Change:** ${priceChange24h}\n\n`;
        message += `🟢 **${rugCheckData.riskLevel}:** ${rugCheckData.riskDescription}\n`;
        message += `🔒 **LPLOCKED:** ${rugCheckData.lpLocked}%\n`;

        await notifySubscribers(message, rugCheckData.imageUrl, dexData.pairAddress, mintAddress);
    } catch (error) {
        console.error("❌ Error al consultar la transacción:", error);
        return "❌ Error al obtener la información del token.";
    }
}

// 🔹 Notificar a los suscriptores con imagen y botones
async function notifySubscribers(message, imageUrl, pairAddress, mint) {
    try {
        for (const userId of subscribers) {
            if (!message.trim()) {
                console.error("⚠️ Error: Mensaje vacío, no se envió.");
                continue;
            }
            await bot.sendPhoto(userId, imageUrl || "https://default-image.com/no-image.jpg", {
                caption: message,
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "💸 Buy Token", url: `https://jup.ag/swap/SOL-${mint}` }],
                        [{ text: "📊 Dexscreener", url: `https://dexscreener.com/solana/${pairAddress}` }]
                    ]
                }
            });
        }
    } catch (error) {
        console.error("❌ Error enviando mensaje a Telegram:", error);
    }
}

// 🔥 Cargar suscriptores
loadSubscribers();

// 🔹 Comando `/start` para suscribirse a notificaciones
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    subscribers.add(chatId);
    saveSubscribers();
    bot.sendMessage(chatId, "🚀 Te has suscrito a las notificaciones de migraciones en Solana.");
});

// 🔹 Comando `/stop` para cancelar suscripción
bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    subscribers.delete(chatId);
    saveSubscribers();
    bot.sendMessage(chatId, "🛑 Has sido eliminado de las notificaciones.");
});

// 🔹 Escuchar mint address en mensajes
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (/^[A-Za-z0-9]{44}$/.test(text)) {
        bot.sendMessage(chatId, "🔄 Consultando datos del token...");
        const details = await getTransactionDetails(text);
        bot.sendMessage(chatId, details, { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(chatId, "❌ Envía un Mint Address válido.");
    }
});

console.log("🤖 Bot de Telegram iniciado.");
