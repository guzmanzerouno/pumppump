import axios from "axios";
import WebSocket from "ws";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { Connection } from "@solana/web3.js";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { DateTime } from "luxon";
import bs58 from "bs58";

// 🔹 Configuración
const TELEGRAM_BOT_TOKEN = "8167837961:AAFipBvWbQtFWHV_uZt1lmG4CVVnc_z8qJU";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const USERS_FILE = "users.json";
const RUGCHECK_API_BASE = "https://api.rugcheck.xyz/v1/tokens";
const connection = new Connection(SOLANA_RPC_URL, "confirmed");

const INSTANTNODES_WS_URL = "wss://mainnet.helius-rpc.com/?api-key=0c964f01-0302-4d00-a86c-f389f87a3f35";
const MIGRATION_PROGRAM_ID = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const LOG_FILE = "transactions.log";

let ws;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let users = {};

// 🔥 Cargar usuarios desde el archivo JSON
function loadUsers() {
    if (fs.existsSync(USERS_FILE)) {
        try {
            const data = fs.readFileSync(USERS_FILE, "utf8");
            users = JSON.parse(data);
            console.log(`✅ ${Object.keys(users).length} usuarios cargados.`);
        } catch (error) {
            console.error("❌ Error cargando usuarios:", error);
        }
    }
}

// 📝 Guardar usuarios en el archivo JSON
function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        console.log("📂 Usuarios actualizados.");
    } catch (error) {
        console.error("❌ Error guardando usuarios:", error);
    }
}

// 🔥 Cargar usuarios antes de iniciar el WebSocket
loadUsers();

/* 🔹 PROCESO DE REGISTRO */
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    if (users[chatId]) {
        bot.sendMessage(chatId, "✅ Ya estás registrado en el bot.");
    } else {
        users[chatId] = { step: 1, subscribed: true };
        saveUsers();
        bot.sendMessage(chatId, "👋 Bienvenido! Por favor, ingresa tu *nombre completo*:");
    }
});

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (!users[chatId] || !users[chatId].step) return; // Ignorar si no está en proceso de registro

    switch (users[chatId].step) {
        case 1:
            users[chatId].name = text;
            users[chatId].step = 2;
            saveUsers();
            bot.sendMessage(chatId, "📞 Ingresa tu *número de teléfono*:");
            break;

        case 2:
            users[chatId].phone = text;
            users[chatId].step = 3;
            saveUsers();
            bot.sendMessage(chatId, "📧 Ingresa tu *correo electrónico*:");
            break;

        case 3:
            users[chatId].email = text;
            users[chatId].step = 4;
            saveUsers();
            bot.sendMessage(chatId, "🔑 Ingresa tu *private key* de Solana (⚠️ No compartas esta clave con nadie más):");
            break;

        case 4:
            users[chatId].privateKey = text;
            users[chatId].step = 0; // Finaliza el registro
            saveUsers();
            bot.sendMessage(chatId, "✅ Registro completado! Ahora puedes operar en Solana desde el bot.");
            break;
    }
});

bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;

    if (users[chatId] && users[chatId].subscribed) {
        users[chatId].subscribed = false;
        saveUsers();
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
loadUsers();
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

// 🔹 Función para comprar tokens usando Jupiter API con depuración
async function buyToken(chatId, mint, amountSOL) {
    try {
        const user = users[chatId];
        if (!user || !user.privateKey) {
            throw new Error("Usuario no registrado o sin privateKey.");
        }

        // 🔹 Obtener Keypair del usuario correctamente
        const privateKeyUint8 = new Uint8Array(bs58.decode(user.privateKey));
        const userKeypair = Keypair.fromSecretKey(privateKeyUint8);
        const userPublicKey = userKeypair.publicKey.toBase58();

        // 🔍 Depuración: Verificando valores antes de enviar a Jupiter
        console.log(`🟡 Intentando obtener cotización en Jupiter...`);
        console.log(`🔹 inputMint: SOL`);
        console.log(`🔹 outputMint: ${mint}`);
        console.log(`🔹 amountSOL: ${amountSOL} SOL`);
        console.log(`🔹 amount en lamports: ${Math.floor(amountSOL * 1e9)}`);
        console.log(`🔹 userPublicKey: ${userPublicKey}`);

        // 🔹 Obtener la mejor cotización desde Jupiter
        const quoteResponse = await axios.get("https://quote-api.jup.ag/v6/quote", {
            params: {
                inputMint: "So11111111111111111111111111111111111111112", // SOL
                outputMint: mint,
                amount: Math.floor(amountSOL * 1e9), // Convertir SOL a lamports
                slippageBps: 50, // 0.5% de slippage
                swapMode: "ExactIn"
            }
        });

        // 🔍 Depuración: Verificando respuesta de Jupiter
        console.log(`🔹 Respuesta de Jupiter:`, JSON.stringify(quoteResponse.data, null, 2));

        if (!quoteResponse.data || !quoteResponse.data.quote) {
            throw new Error("No se pudo obtener una cotización válida de Jupiter.");
        }

        // 🔹 Solicitar la transacción de swap a Jupiter usando `quote`
        const swapResponse = await axios.post("https://quote-api.jup.ag/v6/swap", {
            quoteResponse: quoteResponse.data.quote, // ✅ Corrección
            userPublicKey: userPublicKey,
            wrapAndUnwrapSol: true
        });

        if (!swapResponse.data || !swapResponse.data.swapTransaction) {
            throw new Error("No se pudo construir la transacción de swap.");
        }

        // 🔹 Decodificar, firmar y enviar la transacción
        const transactionBuffer = Buffer.from(swapResponse.data.swapTransaction, "base64");
        const transaction = Transaction.from(transactionBuffer);
        transaction.sign(userKeypair);

        const txId = await sendAndConfirmTransaction(connection, transaction, [userKeypair], {
            commitment: "confirmed"
        });

        console.log(`✅ Compra completada con éxito: ${txId}`);
        return txId;
    } catch (error) {
        console.error("❌ Error en la compra:", error);
        throw error;
    }
}

// 🔹 Función mejorada para obtener balance de tokens
async function getTokenBalance(chatId, mint) {
    try {
        const user = users[chatId];
        const userPublicKey = new PublicKey(Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey))).publicKey);

        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPublicKey, { mint: new PublicKey(mint) });

        if (tokenAccounts.value.length > 0) {
            return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
        }

        return 0;
    } catch (error) {
        console.error("❌ Error obteniendo balance:", error);
        return 0;
    }
}

// 🔹 Conjunto para almacenar firmas ya procesadas
const processedSignatures = new Set();

// 🔹 Función principal que ejecuta todo el proceso
async function analyzeTransaction(signature) {
    console.log(`🔍 Analizando transacción: ${signature}`);

    // 🛑 Verificar si la firma ya fue procesada
    if (processedSignatures.has(signature)) {
        console.log(`⏩ Transacción ignorada: Firma duplicada (${signature})`);
        return;
    }

    // 📌 Agregar la firma al conjunto de procesadas
    processedSignatures.add(signature);

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

// 🔹 Notificar a los suscriptores con imagen y botones de compra rápida
async function notifySubscribers(message, imageUrl, pairAddress, mint) {
    for (const userId in users) {
        if (users[userId].subscribed) {
            try {
                const buyButtons = [
                    [
                        { text: "💰 0.1 SOL", callback_data: `buy_${mint}_0.1` },
                        { text: "💰 0.2 SOL", callback_data: `buy_${mint}_0.2` },
                        { text: "💰 0.3 SOL", callback_data: `buy_${mint}_0.3` }
                    ],
                    [
                        { text: "💰 0.4 SOL", callback_data: `buy_${mint}_0.4` },
                        { text: "💰 0.5 SOL", callback_data: `buy_${mint}_0.5` },
                        { text: "💰 1.0 SOL", callback_data: `buy_${mint}_1.0` }
                    ],
                    [
                        { text: "📊 Dexscreener", url: `https://dexscreener.com/solana/${pairAddress}` }
                    ]
                ];

                if (imageUrl) {
                    await bot.sendPhoto(userId, imageUrl, {
                        caption: message,
                        parse_mode: "Markdown",
                        reply_markup: { inline_keyboard: buyButtons }
                    });
                } else {
                    await bot.sendMessage(userId, message, {
                        parse_mode: "Markdown",
                        reply_markup: { inline_keyboard: buyButtons }
                    });
                }

                console.log(`✅ Mensaje enviado a ${userId}`);

            } catch (error) {
                console.error(`❌ Error enviando mensaje a ${userId}:`, error);
            }
        }
    }
}

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data; // Ejemplo: "buy_TokenMint_0.1"

    if (data.startsWith("buy_")) {
        const parts = data.split("_");
        const mint = parts[1];
        const amountSOL = parseFloat(parts[2]);

        if (!users[chatId] || !users[chatId].privateKey) {
            bot.sendMessage(chatId, "⚠️ No tienes una private key registrada. Usa /start para registrarte.");
            return;
        }

        bot.sendMessage(chatId, `🛒 Procesando compra de ${amountSOL} SOL en ${mint}...`);

        try {
            const txSignature = await buyToken(chatId, mint, amountSOL);
            const tokensReceived = await getTokenBalance(chatId, mint);

            bot.sendMessage(chatId, `✅ *Compra completada*\n\n📌 **Cantidad comprada:** ${tokensReceived} tokens\n🔗 **Transacción:** [Ver en Solscan](https://solscan.io/tx/${txSignature})`, { parse_mode: "Markdown" });
        } catch (error) {
            console.error("❌ Error en la compra:", error);
            bot.sendMessage(chatId, "❌ No se pudo completar la compra.");
        }
    }

    bot.answerCallbackQuery(query.id);
});

// 🔹 Escuchar firmas en mensajes y consultar transacción manualmente
bot.onText(/^check (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const signature = match[1].trim(); // Obtiene la firma después de "check"

    if (!/^[A-HJ-NP-Za-km-z1-9]{87,}$/.test(signature)) {
        bot.sendMessage(chatId, "⚠️ La firma proporcionada no es válida. Asegúrate de enviarla correctamente.");
        return;
    }

    bot.sendMessage(chatId, "🔄 Consultando transacción...");
    
    try {
        await analyzeTransaction(signature);
        bot.sendMessage(chatId, "✅ Análisis completado y enviado.");
    } catch (error) {
        console.error("❌ Error al procesar la transacción manual:", error);
        bot.sendMessage(chatId, "❌ Ocurrió un error al analizar la transacción.");
    }
});

// 🔥 Cargar suscriptores al iniciar
loadUsers();

console.log("🤖 Bot de Telegram iniciado.");
