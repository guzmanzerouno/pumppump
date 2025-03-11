import TelegramBot from "node-telegram-bot-api";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs-extra";
import axios from "axios";

// 🔹 Configuración del bot y RPC
const TELEGRAM_BOT_TOKEN = "8167837961:AAFipBvWbQtFWHV_uZt1lmG4CVVnc_z8qJU";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const BIRDEYE_API_URL = "https://public-api.birdeye.so/public/token-price";
const SUBSCRIBERS_FILE = "subscribers.json";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const connection = new Connection(SOLANA_RPC_URL, "confirmed");
let activeUsers = new Set();

// 🔥 Cargar suscriptores desde el archivo JSON
function loadSubscribers() {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
        const data = fs.readFileSync(SUBSCRIBERS_FILE, "utf8");
        activeUsers = new Set(JSON.parse(data));
        console.log(`✅ ${activeUsers.size} usuarios suscritos cargados.`);
    }
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
                creationTimestamp: tokenData.pairCreatedAt || null
            };
        }
    } catch (error) {
        console.error("⚠️ Error al obtener datos desde DexScreener:", error.message);
    }
    return null;
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

// 🔹 Obtener detalles de la transacción con DexScreener
async function getTransactionDetails(signature) {
    try {
        const transaction = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
        });

        if (!transaction || !transaction.meta || !transaction.meta.preTokenBalances) {
            return "⚠️ No se encontraron datos de token en esta transacción.";
        }

        // 🔹 Extraer información del token
        const tokenInfo = transaction.meta.preTokenBalances.map(token => ({
            mint: token.mint,
            owner: token.owner,
            uiTokenAmount: token.uiTokenAmount.uiAmountString
        }));

        let message = `📜 **Detalles del Token:**\n\n`;

        for (const [index, token] of tokenInfo.entries()) {
            const dexData = await getDexScreenerData(token.mint);
            
            if (!dexData) {
                message += `🔹 **Token #${index + 1}**\n`;
                message += `🪙 **Mint Address:** \`${token.mint}\`\n`;
                message += `📛 **Nombre:** No disponible\n`;
                message += `💲 **Símbolo:** No disponible\n`;
                message += `📈 **Datos de precio no disponibles**\n\n`;
                continue;
            }

            message += `💎 **Símbolo:** ${dexData.symbol}\n`;
            message += `💎 **Nombre:** ${dexData.name}\n`;
            message += `💲 **USD:** ${dexData.priceUsd}\n`;
            message += `💰 **SOL:** ${dexData.priceSol}\n`;
            message += `💧 **Liquidity:** $${dexData.liquidity}\n`;
            message += `📈 **Market Cap:** $${dexData.marketCap}\n`;
            message += `💹 **FDV:** $${dexData.fdv}\n\n`;

            // Obtener detalles adicionales de la transacción
            const slotTime = await connection.getBlockTime(transaction.slot);
            const date = slotTime ? new Date(slotTime * 1000).toLocaleString() : "Desconocida";
            const feePaid = transaction.meta.fee / 1e9; // Convertir a SOL

            message += `📆 **Fecha de Transacción:** ${date}\n`;
            message += `🔄 **Estado:** Confirmado ✅\n\n`;

            // Agregar información del par
            message += `🔗 **Pair:** \`${dexData.pairAddress}\`\n`;
            message += `🔗 **Token:** \`${token.mint}\`\n\n`;

            // Agregar detalles de DEX
            message += `⛓️ **Chain:** ${dexData.chain} ⚡ **Dex:** ${dexData.dex}\n`;
            message += `⏳ **Age:** ${calculateAge(dexData.creationTimestamp)} 📊 **24H Change:** N/A`;
        }

        return message;
    } catch (error) {
        console.error("❌ Error al consultar la transacción:", error);
        return "❌ Error al obtener la información de la transacción.";
    }
}

// 🔹 Obtener metadata del token
async function getTokenMetadata(mintAddress) {
    try {
        const metadataUrl = `https://public-api.solscan.io/token/meta?tokenAddress=${mintAddress}`;
        const response = await axios.get(metadataUrl);
        return response.data || {};
    } catch (error) {
        console.error("❌ Error al obtener metadata del token:", error);
        return {};
    }
}

// 🔹 Obtener precio del token
async function getTokenPrice(mintAddress) {
    try {
        const response = await axios.get(`${BIRDEYE_API_URL}?address=${mintAddress}`);
        return response.data.data || {};
    } catch (error) {
        console.error("❌ Error al obtener precio del token:", error);
        return {};
    }
}

// 🔹 Comando `/start` para suscribirse a notificaciones
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    activeUsers.add(chatId);
    saveSubscribers();
    bot.sendMessage(chatId, "🚀 Te has suscrito a las notificaciones de migraciones en Solana.");
});

// 🔹 Comando `/stop` para cancelar suscripción
bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    activeUsers.delete(chatId);
    saveSubscribers();
    bot.sendMessage(chatId, "🛑 Has sido eliminado de las notificaciones.");
});

// 🔹 Escuchar firmas de transacción en mensajes
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (/^[A-Za-z0-9]{87}$/.test(text)) {
        bot.sendMessage(chatId, "🔄 Consultando datos de la transacción...");
        const details = await getTransactionDetails(text);
        bot.sendMessage(chatId, details, { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(chatId, "❌ Envía una firma de transacción válida.");
    }
});

// 🔥 Cargar suscriptores y mostrar mensaje en consola
loadSubscribers();
console.log("🤖 Bot de Telegram iniciado. Esperando firmas de transacción...");
