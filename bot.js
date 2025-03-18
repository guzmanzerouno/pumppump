import axios from "axios";
import WebSocket from "ws";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { Connection } from "@solana/web3.js";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
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
const JUPITER_API_URL = "https://quote-api.jup.ag/v6/swap";
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

/* 🔹 USER REGISTRATION PROCESS */
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;

    if (users[chatId]) {
        bot.sendMessage(chatId, "✅ You are already registered.");
    } else {
        users[chatId] = { step: 1, subscribed: true };
        saveUsers();
        bot.sendMessage(chatId, "👋 Welcome! Please enter your *full name*:");
    }
});

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (!users[chatId] || !users[chatId].step) return; // Ignore if not in registration process

    switch (users[chatId].step) {
        case 1:
            users[chatId].name = text;
            users[chatId].step = 2;
            saveUsers();
            bot.sendMessage(chatId, "📞 Please enter your *phone number*:");
            break;

        case 2:
            users[chatId].phone = text;
            users[chatId].step = 3;
            saveUsers();
            bot.sendMessage(chatId, "📧 Please enter your *email address*:");
            break;

        case 3:
            users[chatId].email = text;
            users[chatId].step = 4;
            saveUsers();
            bot.sendMessage(chatId, "🔑 Please enter your *Solana private key* (⚠️ Do not share this key with anyone):");
            break;

        case 4:
            try {
                const userPrivateKey = text;

                // 🔹 Decode the private key and generate the public key
                const keypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(userPrivateKey)));
                const walletPublicKey = keypair.publicKey.toBase58();

                // 🔹 Update user data without overwriting previous fields
                users[chatId] = Object.assign({}, users[chatId], {
                    privateKey: userPrivateKey,
                    walletPublicKey: walletPublicKey,
                    step: 0 // Registration complete
                });

                saveUsers();
                bot.sendMessage(chatId, "✅ Registration complete! You can now trade on Solana using the bot.");

            } catch (error) {
                console.error("❌ Error decoding private key:", error);
                bot.sendMessage(chatId, "⚠️ Invalid private key. Please try again.");
            }
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

// 🔹 Obtener datos desde DexScreener hasta que `dexId` sea diferente de `"pumpfun"`
async function getDexScreenerData(mintAddress) {
    let dexData = null;
    
    console.log(`🔄 Buscando en DexScreener para: ${mintAddress}`);
    
    while (!dexData || dexData.dexId === "pumpfun") {
        try {
            const response = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${mintAddress}`);
            if (response.data && response.data.length > 0) {
                dexData = response.data[0];
                console.log(`🔍 Obteniendo datos... DexID: ${dexData.dexId}`);
            }
        } catch (error) {
            console.error("⚠️ Error en DexScreener:", error.message);
        }

        if (!dexData || dexData.dexId === "pumpfun") {
            console.log("⏳ Esperando 1 segundo para volver a intentar...");
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    console.log("✅ DexScreener confirmado en:", dexData.dexId);

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

// 🔹 Obtener datos de riesgo desde RugCheck API con reintentos automáticos
async function fetchRugCheckData(tokenAddress, retries = 3, delayMs = 5000) {
    let attempt = 1;

    while (attempt <= retries) {
        try {
            console.log(`🔍 Fetching RugCheck data (Attempt ${attempt}/${retries})...`);
            const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report`);

            if (!response.data) {
                throw new Error("No response data from RugCheck.");
            }

            const data = response.data;
            return {
                name: data.fileMeta?.name || "N/A",
                symbol: data.fileMeta?.symbol || "N/A",
                imageUrl: data.fileMeta?.image || "",
                riskLevel: data.score <= 1000 ? "🟢 GOOD" : "🔴 WARNING",
                riskDescription: data.risks?.map(r => r.description).join(", ") || "No risks detected",
                lpLocked: data.markets?.[0]?.lp?.lpLockedPct || "N/A"
            };

        } catch (error) {
            console.error(`❌ Error fetching RugCheck data (Attempt ${attempt}):`, error.message);

            if (attempt < retries && error.response?.status === 502) {
                console.log(`⚠ RugCheck API returned 502. Retrying in ${delayMs / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                attempt++;
            } else {
                console.log(`❌ RugCheck API failed after ${retries} attempts.`);
                return null;
            }
        }
    }
}

function saveTokenData(dexData, mintData, rugCheckData, age, priceChange24h, graduations) {
    console.log("🔄 Intentando guardar datos en tokens.json...");

    // 🔹 1️⃣ Verificar si los datos son válidos antes de guardar
    if (!dexData || !mintData || !rugCheckData) {
        console.error("❌ Error: Datos inválidos, no se guardará en tokens.json");
        return;
    }

    console.log("✅ Datos validados correctamente.");
    console.log("🔹 Datos recibidos para guardar:", JSON.stringify({ dexData, mintData, rugCheckData, age, priceChange24h, graduations }, null, 2));

    // 🔹 2️⃣ Formatear datos antes de guardar
    const tokenInfo = {
        symbol: dexData.symbol || "Unknown",
        name: dexData.name || "Unknown",
        USD: dexData.priceUsd || "N/A",
        SOL: dexData.priceSol || "N/A",
        liquidity: dexData.liquidity || "N/A",
        marketCap: dexData.marketCap || "N/A",
        FDV: dexData.fdv || "N/A",
        age: age || "N/A",
        "24H": priceChange24h || "N/A",
        warning: rugCheckData.riskDescription || "N/A",
        LPLOCKED: rugCheckData.lpLocked || "N/A",
        chain: dexData.chain || "solana",
        dex: dexData.dex || "N/A",
        migrationDate: mintData.date || "N/A",
        graduations: graduations || "N/A",
        status: mintData.status || "N/A",
        pair: dexData.pairAddress || "N/A",
        token: mintData.mintAddress || "N/A"
    };

    console.log("🔹 Datos formateados para guardar:", JSON.stringify(tokenInfo, null, 2));

    // 🔹 3️⃣ Verificar si el archivo `tokens.json` existe y es válido
    let tokens = {};
    const filePath = 'tokens.json';

    if (fs.existsSync(filePath)) {
        try {
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            tokens = fileContent.trim() ? JSON.parse(fileContent) : {};
            console.log("📂 Archivo tokens.json leído correctamente.");
        } catch (error) {
            console.error("❌ Error leyendo tokens.json:", error);
            console.log("🔄 Restaurando tokens.json vacío...");
            fs.writeFileSync(filePath, "{}", 'utf-8');
            tokens = {};
        }
    } else {
        console.log("📂 Archivo tokens.json no existe, se creará uno nuevo.");
    }

    // 🔹 4️⃣ Verificar que `mintData.mintAddress` no sea `undefined`
    if (!mintData.mintAddress || mintData.mintAddress === "N/A") {
        console.error("❌ Error: Mint Address inválido, no se guardará en tokens.json.");
        return;
    }

    console.log("🔹 Mint Address a usar como clave:", mintData.mintAddress);

    // 🔹 5️⃣ Guardar los datos en `tokens.json`
    tokens[mintData.mintAddress] = tokenInfo;

    try {
        fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), 'utf-8');
        console.log(`✅ Token ${dexData.symbol} almacenado en tokens.json`);
    } catch (error) {
        console.error("❌ Error guardando token en tokens.json:", error);
    }

    // 🔹 6️⃣ Verificar permisos de escritura en `tokens.json`
    try {
        fs.accessSync(filePath, fs.constants.W_OK);
        console.log("✅ Permisos de escritura en tokens.json verificados.");
    } catch (error) {
        console.error("❌ Error: No hay permisos de escritura en tokens.json.");
        console.log("🔄 Ejecuta este comando para arreglarlo:");
        console.log(`chmod 666 ${filePath}`);
    }
}

function getTokenInfo(mintAddress) {
    if (!fs.existsSync('tokens.json')) return { symbol: "N/A", name: "N/A" };

    const tokens = JSON.parse(fs.readFileSync('tokens.json', 'utf-8')) || {};

    return tokens[mintAddress] || { symbol: "N/A", name: "N/A" };
}

// 🔹 Función para comprar tokens usando Jupiter API con transacciones versionadas
async function buyToken(chatId, mint, amountSOL, attempt = 1) {
    try {
        console.log(`🛒 Attempt ${attempt}: Processing purchase of ${amountSOL} SOL for ${mint}...`);

        const user = users[chatId];
        if (!user || !user.privateKey) {
            throw new Error("User not registered or missing privateKey.");
        }

        // 🔹 Obtener Keypair del usuario correctamente
        const privateKeyUint8 = new Uint8Array(bs58.decode(user.privateKey));
        const userKeypair = Keypair.fromSecretKey(privateKeyUint8);
        const userPublicKey = userKeypair.publicKey;
        const connection = new Connection(SOLANA_RPC_URL, "confirmed");

        // 🔹 Verificar si la cuenta ATA existe, si no, crearla
        const ata = await ensureAssociatedTokenAccount(userKeypair, mint, connection);
        if (!ata) {
            console.log(`⚠️ ATA not found, waiting for creation... Retrying purchase.`);
            return await buyToken(chatId, mint, amountSOL, attempt + 1); // Reintentar después de crear el ATA
        }

        console.log(`✅ ATA verified for ${mint}: ${ata.toBase58()}`);

        // 🔹 Verificar si hay suficiente SOL en la wallet
        const balance = await connection.getBalance(userPublicKey) / 1e9;
        if (balance < amountSOL) {
            throw new Error(`❌ Not enough SOL. Balance: ${balance}, Required: ${amountSOL}`);
        }

        console.log("🔹 Fetching best quote from Jupiter...");

        // 🔹 Obtener la mejor cotización de compra desde Jupiter
        const quoteResponse = await axios.get("https://quote-api.jup.ag/v6/quote", {
            params: {
                inputMint: "So11111111111111111111111111111111111111112", // SOL
                outputMint: mint,
                amount: Math.floor(amountSOL * 1e9), // Convertir SOL a lamports
                slippageBps: 100, // 1% de slippage
                swapMode: "ExactIn"
            }
        });

        if (!quoteResponse.data || !quoteResponse.data.routePlan) {
            throw new Error("❌ Failed to retrieve a valid quote from Jupiter.");
        }

        console.log("✅ Quote obtained, requesting swap transaction...");

        // 🔹 Solicitar la transacción de swap a Jupiter
        const swapResponse = await axios.post("https://quote-api.jup.ag/v6/swap", {
            quoteResponse: quoteResponse.data,
            userPublicKey: userPublicKey.toBase58(),
            wrapAndUnwrapSol: true
        });

        if (!swapResponse.data || !swapResponse.data.swapTransaction) {
            throw new Error("❌ Failed to construct swap transaction.");
        }

        console.log("✅ Swap transaction received from Jupiter.");

        // 🔹 Decodificar la transacción versión 0 correctamente
        const transactionBuffer = Buffer.from(swapResponse.data.swapTransaction, "base64");
        const versionedTransaction = VersionedTransaction.deserialize(transactionBuffer);

        // 🔹 Firmar la transacción
        versionedTransaction.sign([userKeypair]);

        console.log("✅ Transaction successfully signed. Sending to Solana...");

        // 🔹 Enviar y confirmar la transacción
        const txId = await connection.sendTransaction(versionedTransaction, {
            skipPreflight: false,
            preflightCommitment: "confirmed"
        });

        console.log(`✅ Purchase completed successfully: ${txId}`);
        return txId;

    } catch (error) {
        console.error(`❌ Error in purchase attempt ${attempt}:`, error.message);

        if (attempt < 3) {
            console.log(`🔄 Retrying purchase (Attempt ${attempt + 1})...`);
            return await buyToken(chatId, mint, amountSOL, attempt + 1);
        } else {
            console.error("❌ Maximum retries reached. Purchase failed.");
            return null;
        }
    }
}

async function getTokenBalance(chatId, mint) {
    try {
        if (!users[chatId] || !users[chatId].walletPublicKey) {
            console.error(`⚠️ No se encontró el usuario ${chatId} o no tiene walletPublicKey.`);
            return 0;
        }

        const userPublicKeyString = users[chatId].walletPublicKey;
        
        if (!userPublicKeyString || typeof userPublicKeyString !== "string") {
            console.error(`⚠️ walletPublicKey inválido para el usuario ${chatId}:`, userPublicKeyString);
            return 0;
        }

        const userPublicKey = new PublicKey(userPublicKeyString); // 🔥 Corrección aquí

        console.log(`🔎 Consultando balance del token ${mint} para la wallet ${userPublicKey.toBase58()}`);

        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPublicKey, {
            mint: new PublicKey(mint)
        });

        if (tokenAccounts.value.length > 0) {
            const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
            console.log(`✅ Balance encontrado: ${balance} tokens`);
            return balance;
        }

        console.log("⚠️ No se encontraron tokens en la wallet.");
        return 0;
    } catch (error) {
        console.error("❌ Error obteniendo balance:", error);
        return 0;
    }
}

async function executeJupiterSell(chatId, mint, amount) {
    try {
        console.log(`🔄 Preparing sale of ${amount} tokens for mint: ${mint}`);

        const user = users[chatId];
        if (!user || !user.privateKey) {
            console.error(`⚠️ Private key not found for user: ${JSON.stringify(user || {})}`);
            return null;
        }

        const wallet = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
        const connection = new Connection(SOLANA_RPC_URL, "confirmed");
        console.log(`🔹 Wallet used for sale: ${wallet.publicKey.toBase58()}`);

        // 🔹 Asegurar que la ATA existe antes de vender
        const ata = await ensureAssociatedTokenAccount(wallet, mint, connection);
        if (!ata) {
            throw new Error(`❌ No se pudo crear la ATA para ${mint}, cancelando la venta.`);
        }
        console.log(`✅ ATA verificada para ${mint}: ${ata.toBase58()}`);

        // 🔹 Obtener decimales del token
        const tokenDecimals = await getTokenDecimals(mint);
        console.log(`✅ Token ${mint} has ${tokenDecimals} decimals.`);

        // 🔹 Obtener balance actual en UI units
        let balance = await getTokenBalance(chatId, mint);
        console.log(`✅ Balance found: ${balance} tokens`);

        // 🔹 Convertir balance y cantidad a vender a unidades mínimas
        const balanceInUnits = Math.floor(balance * Math.pow(10, tokenDecimals));
        let amountInUnits = Math.floor(amount * Math.pow(10, tokenDecimals));

        console.log(`🔹 Balance en unidades mínimas: ${balanceInUnits}`);
        console.log(`🔹 Cantidad a vender en unidades mínimas: ${amountInUnits}`);

        // 🔹 Ajustar cantidad a vender si es mayor al balance disponible
        if (amountInUnits > balanceInUnits) {
            console.warn(`⚠ Adjusting sell amount: Trying to sell ${amountInUnits}, but only ${balanceInUnits} available.`);
            amountInUnits = balanceInUnits;
        }

        if (!balanceInUnits || balanceInUnits < amountInUnits) {
            console.error(`❌ Insufficient balance. Trying to sell ${amountInUnits}, but only ${balanceInUnits} available.`);
            return null;
        }

        console.log("🔹 Fetching Jupiter sell quote...");

        // 🔹 Obtener cotización de venta en Jupiter
        const quoteResponse = await axios.get("https://quote-api.jup.ag/v6/quote", {
            params: {
                inputMint: mint,
                outputMint: "So11111111111111111111111111111111111111112", // SOL
                amount: amountInUnits,
                slippageBps: 100
            }
        });

        if (!quoteResponse.data || !quoteResponse.data.routePlan) {
            console.error("❌ No valid quote retrieved from Jupiter.");
            return null;
        }

        console.log("✅ Successfully obtained sell quote.", quoteResponse.data);

        // 🔹 Solicitar transacción de swap a Jupiter
        const swapResponse = await axios.post(JUPITER_API_URL, {
            quoteResponse: quoteResponse.data,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true
        });

        if (!swapResponse.data || !swapResponse.data.swapTransaction) {
            console.error("❌ Failed to construct swap transaction.");
            return null;
        }

        console.log("✅ Swap transaction received from Jupiter.");

        // 🔹 Decodificar y firmar la transacción
        const transactionBuffer = Buffer.from(swapResponse.data.swapTransaction, "base64");
        const versionedTransaction = VersionedTransaction.deserialize(transactionBuffer);
        versionedTransaction.sign([wallet]);

        console.log("✅ Transaction successfully signed.");
        console.log("🚀 Sending transaction to Solana network...");

        // 🔹 Enviar transacción a Solana
        const txSignature = await connection.sendTransaction(versionedTransaction, {
            skipPreflight: false,
            preflightCommitment: "confirmed"
        });

        console.log(`✅ Sell transaction executed successfully: ${txSignature}`);
        return txSignature;
    } catch (error) {
        console.error("❌ Error executing sell order on Jupiter:", error);
        return null;
    }
}

// 🔹 Obtener los decimales del token
async function getTokenDecimals(mint) {
    try {
        const tokenInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
        
        if (!tokenInfo.value || !tokenInfo.value.data) {
            console.warn(`⚠️ No se encontró información del token ${mint}, usando 6 decimales por defecto.`);
            return 6; // Asume 6 si no encuentra info
        }

        const decimals = tokenInfo.value.data.parsed.info.decimals;
        console.log(`✅ Token ${mint} tiene ${decimals} decimales.`);
        return decimals;
    } catch (error) {
        console.error(`❌ Error obteniendo decimales del token ${mint}:`, error);
        return 6; // Devuelve 6 como fallback
    }
}

// 🔹 Función para verificar y crear la ATA si no existe
async function ensureAssociatedTokenAccount(wallet, mint, connection) {
    try {
        const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey);

        // 🔹 Verificar si la cuenta ya existe en la blockchain
        const ataInfo = await connection.getAccountInfo(ata);
        if (ataInfo !== null) {
            console.log(`✅ ATA already exists for ${mint}: ${ata.toBase58()}`);
            return ata;
        }

        console.log(`⚠️ ATA not found, creating a new one for token ${mint}...`);

        // 🔹 Crear la instrucción para la ATA
        const transaction = new Transaction().add(
            createAssociatedTokenAccountInstruction(
                wallet.publicKey,  // Payer (quién paga la transacción)
                ata,               // Dirección de la ATA
                wallet.publicKey,  // Owner (propietario)
                new PublicKey(mint) // Mint del token
            )
        );

        // 🔹 Firmar y enviar la transacción
        const txSignature = await sendAndConfirmTransaction(connection, transaction, [wallet]);

        console.log(`✅ ATA created successfully: ${ata.toBase58()} - TX: ${txSignature}`);

        return ata;
    } catch (error) {
        console.error(`❌ Error creating ATA for ${mint}:`, error);
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
async function analyzeTransaction(signature) {
    console.log(`🔍 Analizando transacción: ${signature}`);

    if (processedSignatures.has(signature)) {
        console.log(`⏩ Transacción ignorada: Firma duplicada (${signature})`);
        return;
    }

    processedSignatures.add(signature);

    let mintData = await getMintAddressFromTransaction(signature);
    if (!mintData || !mintData.mintAddress) {
        console.log("⚠️ No se pudo obtener el Mint Address. Asumiendo que la firma es un Mint Address.");
        mintData = { mintAddress: signature };
    }

    if (mintData.mintAddress === "So11111111111111111111111111111111111111112") {
        console.log("⏩ Transacción ignorada: Wrapped SOL detectado.");
        return;
    }

    console.log(`✅ Mint Address identificado: ${mintData.mintAddress}`);

    const dexData = await getDexScreenerData(mintData.mintAddress);
    if (!dexData) {
        console.log(`⚠️ No se pudo obtener información de DexScreener para ${mintData.mintAddress}`);
        return;
    }
    console.log(`✅ Datos de DexScreener obtenidos para ${mintData.mintAddress}`);

    const rugCheckData = await fetchRugCheckData(mintData.mintAddress);
    if (!rugCheckData) {
        console.log(`⚠️ No se pudo obtener información de RugCheck para ${mintData.mintAddress}`);
        return;
    }
    console.log(`✅ Datos de RugCheck obtenidos para ${mintData.mintAddress}`);

    const priceChange24h = dexData.priceChange24h !== "N/A"
        ? `${dexData.priceChange24h > 0 ? "🟢 +" : "🔴 "}${dexData.priceChange24h}%`
        : "N/A";

    const age = calculateAge(dexData.creationTimestamp) || "N/A";
    const graduations = calculateGraduations(mintData.date, age) || "N/A";

    // 🔹 🔥 **GUARDAR LOS DATOS EN tokens.json**
    console.log("💾 Guardando datos en tokens.json...");
    saveTokenData(dexData, mintData, rugCheckData, age, priceChange24h, graduations);


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

// 🔹 Notificar a los usuarios con botones de compra y venta
async function notifySubscribers(message, imageUrl, pairAddress, mint) {
    if (!mint) {
        console.error("⚠️ Mint inválido, no se enviará notificación.");
        return;
    }

    for (const userId in users) {
        const user = users[userId];

        // Evitar enviar mensajes a usuarios no registrados
        if (!user || !user.subscribed || !user.privateKey) continue;

        try {
            const actionButtons = [
                [
                    { text: "💰 0.1 Sol", callback_data: `buy_${mint}_0.1` },
                    { text: "💰 0.2 Sol", callback_data: `buy_${mint}_0.2` },
                    { text: "💰 0.3 Sol", callback_data: `buy_${mint}_0.3` }
                ],
                [
                    { text: "💰 0.4 Sol", callback_data: `buy_${mint}_0.4` },
                    { text: "💰 0.5 Sol", callback_data: `buy_${mint}_0.5` },
                    { text: "💰 1.0 Sol", callback_data: `buy_${mint}_1.0` }
                ],
                [
                    { text: "💵 Sell 50%", callback_data: `sell_${mint}_50` },
                    { text: "💯 Sell MAX", callback_data: `sell_${mint}_max` }
                ],
                [
                    { text: "📊 Dexscreener", url: `https://dexscreener.com/solana/${pairAddress}` }
                ]
            ];

            if (imageUrl) {
                await bot.sendPhoto(userId, imageUrl, {
                    caption: message,
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: actionButtons }
                });
            } else {
                await bot.sendMessage(userId, message, {
                    parse_mode: "Markdown",
                    reply_markup: { inline_keyboard: actionButtons }
                });
            }

            console.log(`✅ Mensaje enviado a ${userId}`);

        } catch (error) {
            console.error(`❌ Error enviando mensaje a ${userId}:`, error);
        }
    }
}

async function getTokenNameFromSolana(mintAddress) {
    try {
        const tokenInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
        
        if (!tokenInfo.value || !tokenInfo.value.data) {
            console.warn(`⚠️ No se encontró información del token ${mintAddress} en Solana RPC.`);
            return null;
        }

        const parsedData = tokenInfo.value.data.parsed.info;
        return {
            name: parsedData.name || "Unknown",
            symbol: parsedData.symbol || "N/A"
        };

    } catch (error) {
        console.error(`❌ Error obteniendo información del token ${mintAddress}:`, error);
        return null;
    }
}

async function getSwapDetailsFromSolanaRPC(signature) {
    let retryAttempts = 0;
    let delay = 5000; // 5 segundos inicial antes de la primera consulta

    while (retryAttempts < 6) { // Máximo de 6 intentos
        try {
            console.log(`🔍 Fetching transaction details for: ${signature} (Attempt ${retryAttempts + 1})`);

            const response = await axios.post("https://api.mainnet-beta.solana.com", {
                jsonrpc: "2.0",
                id: 1,
                method: "getTransaction",
                params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]
            });

            if (!response.data || !response.data.result) {
                throw new Error("❌ No transaction details found.");
            }

            const txData = response.data.result;
            const meta = txData.meta;

            if (meta.err) {
                throw new Error("Transaction failed on Solana.");
            }

            const preBalances = meta.preBalances;
            const postBalances = meta.postBalances;
            const swapFee = meta.fee / 1e9;

            // 🔍 Buscar el token vendido o recibido
            const soldToken = meta.preTokenBalances.find(token => token.accountIndex !== 0);
            const receivedToken = meta.postTokenBalances.find(token => token.accountIndex !== 0);

            const soldAmount = soldToken ? parseFloat(soldToken.uiTokenAmount.uiAmountString) : "N/A";
            const receivedAmount = receivedToken ? parseFloat(receivedToken.uiTokenAmount.uiAmountString) : "N/A";

            const soldTokenMint = soldToken ? soldToken.mint : "Unknown";
            const receivedTokenMint = receivedToken ? receivedToken.mint : "Unknown";

            // 🔹 Intentar obtener el nombre y símbolo del token vendido
            let soldTokenInfo = getTokenInfo(soldTokenMint);
            let receivedTokenInfo = getTokenInfo(receivedTokenMint);

            const soldTokenName = soldTokenInfo?.name || "Unknown";
            const soldTokenSymbol = soldTokenInfo?.symbol || "N/A";

            const receivedTokenName = receivedTokenInfo?.name || "Unknown";
            const receivedTokenSymbol = receivedTokenInfo?.symbol || "N/A";

            // Detectar en qué plataforma se hizo el swap (Jupiter, Raydium, Meteora, etc.)
            const dexPlatform = detectDexPlatform(txData.transaction.message.accountKeys);

            const solBefore = preBalances[0] / 1e9;
            const solAfter = postBalances[0] / 1e9;
            const inputAmount = (solBefore - solAfter - swapFee).toFixed(6);

            return {
                inputAmount: inputAmount,
                soldAmount: soldAmount,  // 🔹 Cantidad de tokens vendidos
                receivedAmount: receivedAmount,  // 🔹 Cantidad de SOL recibidos
                swapFee: swapFee.toFixed(6),
                soldTokenMint: soldTokenMint,
                receivedTokenMint: receivedTokenMint,
                soldTokenName: soldTokenName,
                soldTokenSymbol: soldTokenSymbol,
                receivedTokenName: receivedTokenName,
                receivedTokenSymbol: receivedTokenSymbol,
                dexPlatform: dexPlatform,
                walletAddress: txData.transaction.message.accountKeys[0],
                solBefore: solBefore.toFixed(3),
                solAfter: solAfter.toFixed(3)
            };

        } catch (error) {
            console.error(`❌ Error retrieving swap details (Attempt ${retryAttempts + 1}):`, error.message);

            if (error.response && error.response.status === 429) {
                console.log("⚠️ Rate limit reached, waiting longer before retrying...");
                delay *= 1.5;
            } else {
                delay *= 1.2;
            }

            await new Promise(resolve => setTimeout(resolve, delay));
            retryAttempts++;
        }
    }

    console.error("❌ Failed to retrieve swap details after multiple attempts.");
    return null;
}

function detectDexPlatform(accountKeys) {
    const dexIdentifiers = {
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter",
        "mete1GCG6pESFVkMyfrgXW1UV3pR7xyF6LT1r6dTC4y": "Meteora",
        "CAMt6JZJHj3AgGrwvvXL4LoNZFxtFnS2LZKPh8UmeHqT": "Raydium",
        "9Wq5m2K2JhE7G7q8jK8HgyR7Atsj6qGkTRS8UnToV2pj": "Orca"
    };

    for (const key of accountKeys) {
        if (dexIdentifiers[key]) {
            return dexIdentifiers[key];
        }
    }
    return "Unknown DEX";
}

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith("sell_")) {
        const parts = data.split("_");
        const mint = parts[1];
        const sellType = parts[2];

        console.log(`🔍 Debug - User before selling:`, JSON.stringify(users[chatId], null, 2));

        if (!users[chatId] || !users[chatId].privateKey) {
            console.error(`⚠ Private key not found for user: ${JSON.stringify(users[chatId])}`);
            bot.sendMessage(chatId, "⚠️ Error: Private key not found.");
            return;
        }

        bot.sendMessage(chatId, `🔄 Processing sale of ${sellType === "50" ? "50%" : "100%"} of your ${mint} tokens...`);

        try {
            // 🔹 Obtener Keypair de la wallet del usuario
            const wallet = Keypair.fromSecretKey(new Uint8Array(bs58.decode(users[chatId].privateKey)));
            const connection = new Connection(SOLANA_RPC_URL, "confirmed");

            // 🔹 Verificar y crear la ATA si es necesario antes de vender
            const ata = await ensureAssociatedTokenAccount(wallet, mint, connection);
            if (!ata) {
                throw new Error(`❌ Failed to create or retrieve the ATA for ${mint}`);
            }

            console.log(`✅ ATA verified for selling: ${ata.toBase58()}`);

            // 🔹 Obtener decimales del token
            const decimals = await getTokenDecimals(mint);
            console.log(`✅ Token ${mint} has ${decimals} decimals.`);

            // 🔹 Obtener balance del token en UI units
            let balance = await getTokenBalance(chatId, mint);
            console.log(`✅ Balance found: ${balance} tokens`);

            if (!balance || balance <= 0) {
                bot.sendMessage(chatId, "⚠️ You don't have enough balance to sell.");
                return;
            }

            // 🔹 Convertir balance a unidades mínimas (lamports)
            let balanceInLamports = Math.floor(balance * Math.pow(10, decimals));

            // 🔹 Determinar cantidad a vender (50% o 100%)
            let amountToSell = sellType === "50" ? Math.floor(balanceInLamports / 2) : balanceInLamports;
            console.log(`🔹 Selling amount in lamports: ${amountToSell}`);

            // 🔹 Evitar vender cantidades menores que la unidad mínima del token
            if (amountToSell < 1) {
                bot.sendMessage(chatId, "⚠️ The amount to sell is too low.");
                return;
            }

            let attempts = 0;
            let txSignature = null;

            // 🔄 Intentar vender hasta 3 veces si falla la transacción
            while (attempts < 3 && !txSignature) {
                attempts++;
                console.log(`🔄 Attempt ${attempts}/3 to execute sale...`);
                txSignature = await executeJupiterSell(chatId, mint, amountToSell);
                if (!txSignature) {
                    console.log(`⚠️ Sale attempt ${attempts} failed.`);
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Esperar 5 segundos antes de reintentar
                }
            }

            if (!txSignature) {
                bot.sendMessage(chatId, "❌ The sale could not be completed after multiple attempts.");
                return;
            }

            // ✅ Notificar al usuario que la orden de venta fue ejecutada
            bot.sendMessage(
                chatId,
                `✅ *Sell order executed!*\n🔗 [View in Solscan](https://solscan.io/tx/${txSignature})\n⏳ *Fetching sell details...*`,
                { parse_mode: "Markdown", disable_web_page_preview: true }
            );

            console.log("⏳ Waiting for Solana to confirm the transaction...");
            await new Promise(resolve => setTimeout(resolve, 10000));

            let sellDetails = await getSwapDetailsFromSolanaRPC(txSignature);

            if (!sellDetails) {
                bot.sendMessage(
                    chatId,
                    `⚠️ Sell details could not be retrieved. Transaction: [View in Solscan](https://solscan.io/tx/${txSignature})`,
                    { parse_mode: "Markdown", disable_web_page_preview: true }
                );
                return;
            }

            // 🔹 Obtener información del token vendido desde tokens.json
            const sellTokenData = getTokenInfo(sellDetails.receivedTokenMint);

            // 📌 Mensaje final de confirmación de venta
            const sellMessage = `✅ *Sell completed successfully*\n` +
            `*${escapeMarkdown(sellTokenData.symbol || "Unknown")}/SOL* (${escapeMarkdown(sellDetails.dexPlatform || "Unknown DEX")})\n\n` +
            `⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️\n\n` +
            `💰 *Sold:* ${sellDetails.receivedAmount !== "N/A" ? sellDetails.receivedAmount : "Unknown"} Tokens\n` +
            `💰 *Got:* ${sellDetails.inputAmount} SOL\n` +
            `🔄 *Sell Fee:* ${sellDetails.swapFee} SOL\n` +
            `📌 *Sold Token ${escapeMarkdown(sellTokenData.symbol || "Unknown")}:* \`${sellDetails.receivedTokenMint}\`\n` +
            `📌 *Wallet:* \`${sellDetails.walletAddress}\`\n\n` +
            `💰 *SOL before sell:* ${sellDetails.solBefore} SOL\n` +
            `💰 *SOL after sell:* ${sellDetails.solAfter} SOL\n`;

            bot.sendMessage(chatId, sellMessage, { parse_mode: "Markdown", disable_web_page_preview: true });

        } catch (error) {
            console.error("❌ Error in sell process:", error);
            bot.sendMessage(chatId, "❌ The sale could not be completed.");
        }
    }

    bot.answerCallbackQuery(query.id);
});

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data; 

    if (data.startsWith("buy_")) {
        const parts = data.split("_");
        const mint = parts[1];
        const amountSOL = parseFloat(parts[2]);

        if (!users[chatId] || !users[chatId].privateKey) {
            bot.sendMessage(chatId, "⚠️ You don't have a registered private key. Use /start to register.");
            return;
        }

        bot.sendMessage(chatId, `🛒 Processing purchase of ${amountSOL} SOL for ${mint}...`);

        try {
            const txSignature = await buyToken(chatId, mint, amountSOL);

            if (!txSignature) {
                bot.sendMessage(chatId, "❌ The purchase could not be completed.");
                return;
            }

            bot.sendMessage(chatId, `✅ *Purchase order executed!*\n🔗 *Transaction:* [View in Solscan](https://solscan.io/tx/${txSignature})\n⏳ *Fetching swap details...*`, { parse_mode: "Markdown", disable_web_page_preview: true });

            console.log("⏳ Waiting for Solana to confirm the transaction...");
            await new Promise(resolve => setTimeout(resolve, 10000));

            let swapDetails = await getSwapDetailsFromSolanaRPC(txSignature);

            if (!swapDetails) {
                bot.sendMessage(chatId, `⚠️ Swap details could not be retrieved.`, { parse_mode: "Markdown", disable_web_page_preview: true });
                return;
            }

            const swapTokenData = getTokenInfo(swapDetails.receivedTokenMint);  // 🔹 Obtener información del token comprado

            const confirmationMessage = `✅ *Swap completed successfully*\n` +
            `*SOL/${escapeMarkdown(swapTokenData.symbol || "Unknown")}* (${escapeMarkdown(swapDetails.dexPlatform || "Unknown DEX")})\n\n` +
            `⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️\n\n` +
            `💰 *Spent:* ${swapDetails.inputAmount} SOL\n` +
            `🔄 *Got:* ${swapDetails.receivedAmount} Tokens\n` +
            `🔄 *Swap Fee:* ${swapDetails.swapFee} SOL\n` +
            `📌 *Received Token ${escapeMarkdown(swapTokenData.symbol || "Unknown")}:* \`${swapDetails.receivedTokenMint}\`\n` + 
            `📌 *Wallet:* \`${swapDetails.walletAddress}\`\n\n` +
            `💰 *SOL before swap:* ${swapDetails.solBefore} SOL\n` +
            `💰 *SOL after swap:* ${swapDetails.solAfter} SOL\n`;

            bot.sendMessage(chatId, confirmationMessage, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "💸 Sell 50%", callback_data: `sell_${swapDetails.receivedTokenMint}_50` },
                            { text: "💯 Sell MAX", callback_data: `sell_${swapDetails.receivedTokenMint}_100` }
                        ],
                        [
                            { text: "📈 Dexscreener", url: `https://dexscreener.com/solana/${swapDetails.receivedTokenMint}` }
                        ]
                    ]
                }
            });

        } catch (error) {
            console.error("❌ Error in purchase process:", error);
            bot.sendMessage(chatId, "❌ The purchase could not be completed.");
        }
    }

    bot.answerCallbackQuery(query.id);
});

// 🔹 Escuchar firmas de transacción o mint addresses en mensajes
bot.onText(/^check (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim(); // Obtiene la entrada después de "check"

    // Validar si es una firma de transacción (Base58 de 87+ caracteres)
    const isTransactionSignature = /^[A-HJ-NP-Za-km-z1-9]{87,}$/.test(input);

    bot.sendMessage(chatId, "🔄 Fetching details...");

    try {
        let transactionSignature = null;
        let mintAddress = input;

        if (isTransactionSignature) {
            // Caso 1: El usuario ingresó una firma de transacción, buscamos el Mint Address
            transactionSignature = input;
            const transactionData = await getMintAddressFromTransaction(transactionSignature);

            if (!transactionData || !transactionData.mintAddress) {
                bot.sendMessage(chatId, "⚠️ Could not retrieve transaction details.");
                return;
            }

            mintAddress = transactionData.mintAddress;
        }

        // Ejecutar la función principal analyzeTransaction() con el Mint Address
        const analysisMessage = await analyzeTransaction(mintAddress, chatId);

        // Enviar el resultado solo al usuario que hizo la consulta
        bot.sendMessage(chatId, analysisMessage, { parse_mode: "Markdown" });

    } catch (error) {
        console.error("❌ Error processing request:", error);
        bot.sendMessage(chatId, "❌ Error retrieving data.");
    }
});

// 🔥 Cargar suscriptores al iniciar
loadUsers();

console.log("🤖 Bot de Telegram iniciado.");
