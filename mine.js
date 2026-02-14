const express = require('express');
const mineflayer = require('mineflayer');
const path = require('path');
const { ProxyAgent } = require('proxy-agent');
const fs = require('fs');
const bodyParser = require('body-parser');

const app = express();

// Увеличиваем лимиты для обработки больших запросов
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

let activeBots = {};
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const PROXY_FILE = path.join(__dirname, 'proxy.txt');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.txt');
const PROGRESS_FILE = path.join(__dirname, 'progress.json');

// Конфигурация по умолчанию
const defaultConfig = {
    theme: {
        primary: '#4CAF50',
        secondary: '#111',
        background: '#0a0a0a',
        text: '#eee',
        accent: '#00e5ff'
    },
    defaultTpNick: '9sparserUeutral',
    autoCollectThreshold: 1,
    batchSize: 100,
    delayBetweenBatches: 60000, // 1 минута между партиями
    delayBetweenAccounts: 10000 // 10 секунд между аккаунтами
};

let config = { ...defaultConfig };

// Прогресс добавления аккаунтов
let progress = {
    total: 0,
    added: 0,
    pending: 0,
    currentBatch: 0,
    totalBatches: 0,
    isAdding: false,
    lastAdded: 0,
    accountsQueue: []
};

// Загрузка конфигурации
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            config = { ...defaultConfig, ...saved };
        }
    } catch (e) {
        console.log('Ошибка загрузки конфига:', e.message);
    }
}

// Сохранение конфигурации
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.log('Ошибка сохранения конфига:', e.message);
    }
}

// Загрузка прогресса
function loadProgress() {
    try {
        if (fs.existsSync(PROGRESS_FILE)) {
            progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        }
    } catch (e) {
        console.log('Ошибка загрузки прогресса:', e.message);
    }
}

// Сохранение прогресса
function saveProgress() {
    try {
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    } catch (e) {
        console.log('Ошибка сохранения прогресса:', e.message);
    }
}

loadConfig();
loadProgress();

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(PROXY_FILE)) fs.writeFileSync(PROXY_FILE, '');
if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, '');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Случайная задержка между min и max
const randomSleep = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

function getProxies() {
    try {
        const data = fs.readFileSync(PROXY_FILE, 'utf8');
        return data.split('\n').map(l => l.trim()).filter(l => l.length > 10);
    } catch (e) { return []; }
}

// Сохранение аккаунтов в файл
function saveAccountsToFile(accounts) {
    try {
        const existing = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
        const lines = accounts.split('\n').filter(l => l.trim());
        const newAccounts = lines.filter(line => !existing.includes(line.split(' - ')[0]?.trim()));
        
        if (newAccounts.length > 0) {
            fs.appendFileSync(ACCOUNTS_FILE, '\n' + newAccounts.join('\n'));
            return newAccounts.length;
        }
        return 0;
    } catch (e) {
        // Если файла нет, создаем новый
        fs.writeFileSync(ACCOUNTS_FILE, accounts);
        return accounts.split('\n').filter(l => l.trim()).length;
    }
}

// Загрузка аккаунтов из файла с ограничением
function loadAccountsFromFile(limit = 5000) {
    try {
        const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
        const lines = data.split('\n').filter(l => l.trim());
        return lines.slice(0, limit);
    } catch (e) {
        return [];
    }
}

// Функция обновления спавнеров
function refreshSpawnerCount(bot, username) {
    if (!bot || !bot.inventory) return;
    let count = 0;
    bot.inventory.items().forEach(i => {
        if (i.name.includes('spawner') || i.displayName.includes('Spawner')) count += i.count;
    });
    if (activeBots[username]) activeBots[username].spawners = count;
}

// ФУНКЦИЯ AFK
async function goToAfk(bot, username) {
    if (!bot || !bot.entity) return;
    try {
        activeBots[username].status = `🏃 Иду в AFK...`;
        bot.chat('/afk');
        
        // Ждем 10 секунд пока откроется меню
        await sleep(10000);
        
        // Кликаем на слот 49 в открывшемся меню
        if (bot.currentWindow) {
            activeBots[username].status = `🖱 Выбираю AFK комнату...`;
            await bot.clickWindow(49, 0, 0);
        }
        
        // Ждем немного для подтверждения
        await sleep(3000);
        
        activeBots[username].status = `💤 AFK`;
        activeBots[username].isAfk = true;
        activeBots[username].isCollecting = false;
        activeBots[username].online = true;
    } catch (e) {
        console.log(`[${username}] Ошибка в AFK:`, e.message);
        activeBots[username].status = '❌ Ошибка AFK';
        activeBots[username].isAfk = false;
        activeBots[username].isCollecting = false;
    }
}

// ФУНКЦИЯ СБОРА
async function startCollect(bot, username, targetNick) {
    if (!activeBots[username] || activeBots[username].isCollecting) return;
    activeBots[username].isCollecting = true;
    activeBots[username].isAfk = false;

    try {
        activeBots[username].status = `✉️ TPA к ${targetNick}...`;
        bot.chat(`/tpa ${targetNick}`);
        await sleep(10000);

        if (bot.currentWindow) {
            activeBots[username].status = `🖱 Клик по ячейке 16...`;
            await bot.clickWindow(16, 0, 0);
        }

        activeBots[username].status = `⏳ Ожидание 5 мин...`;
        await sleep(300000); 

        await goToAfk(bot, username);
    } catch (e) {
        activeBots[username].isCollecting = false;
        activeBots[username].status = '❌ Ошибка сбора';
    }
}

// ФУНКЦИЯ МАССОВОГО СБОРА
async function collectAllBotsWithSpawners(targetNick = config.defaultTpNick) {
    const botsToCollect = [];
    
    for (const [username, botData] of Object.entries(activeBots)) {
        if (botData.online && 
            !botData.error && 
            !botData.isCollecting && 
            botData.spawners >= config.autoCollectThreshold &&
            botData.botInstance) {
            botsToCollect.push({ username, bot: botData.botInstance });
        }
    }
    
    if (botsToCollect.length === 0) return { success: false, message: 'Нет ботов для сбора' };
    
    // Запускаем сбор с небольшими задержками чтобы избежать спама
    for (let i = 0; i < botsToCollect.length; i++) {
        const { username, bot } = botsToCollect[i];
        setTimeout(() => {
            startCollect(bot, username, targetNick);
        }, i * 2000); // Задержка 2 секунды между ботами
    }
    
    return { success: true, count: botsToCollect.length };
}

// ФУНКЦИЯ ПОКУПКИ СПАВНЕРА
async function buySpawner(bot, username) {
    if (activeBots[username].isBuying) return;
    activeBots[username].isBuying = true;
    
    try {
        activeBots[username].status = '🛒 Открываю магазин...';
        bot.chat('/shardshop');
        
        // Ждем 5-10 секунд
        await randomSleep(5000, 10000);
        
        // Клик по категории спавнеров (ячейка 13)
        if (bot.currentWindow) {
            activeBots[username].status = '🖱 Выбираю категорию...';
            await bot.clickWindow(13, 0, 0);
        } else {
            throw new Error('Окно магазина не открылось');
        }
        
        // Ждем 5-15 секунд
        await randomSleep(5000, 15000);
        
        // Покупка спавнера (ячейка 15) - 1 спавнер за 500 шардов
        if (bot.currentWindow) {
            activeBots[username].status = '💰 Покупаю спавнер...';
            await bot.clickWindow(15, 0, 0);
        }
        
        // Ждем немного перед закрытием
        await randomSleep(2000, 3000);
        
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow);
        }
        
        // Обновляем количество спавнеров
        refreshSpawnerCount(bot, username);
        
        // Вычитаем потраченные шарды (500 за спавнер)
        if (activeBots[username].shards >= 500) {
            activeBots[username].shards -= 500;
        }
        
        activeBots[username].status = '✅ Спавнер куплен!';
        
    } catch (e) {
        console.log(`[${username}] Ошибка в магазине:`, e.message);
        activeBots[username].status = '❌ Ошибка покупки';
    } finally {
        // Даем небольшую задержку перед сбросом флага
        setTimeout(() => {
            activeBots[username].isBuying = false;
        }, 5000);
    }
}

// Глобальный счетчик для ротации прокси
let proxyRotationIndex = 0;

function getNextProxy() {
    const proxies = getProxies();
    if (proxies.length === 0) return null;
    
    // Берем следующий прокси по кругу
    const proxy = proxies[proxyRotationIndex % proxies.length];
    proxyRotationIndex++;
    
    return proxy;
}

// Очередь на подключение
const connectionQueue = [];
let isProcessingQueue = false;

// Функция для обработки очереди подключений
async function processConnectionQueue() {
    if (isProcessingQueue || connectionQueue.length === 0) return;
    
    isProcessingQueue = true;
    
    while (connectionQueue.length > 0) {
        const { token, index, retryCount } = connectionQueue.shift();
        
        try {
            await createBotFromToken(token, index, retryCount);
            
            // Задержка между подключениями
            await sleep(5000);
        } catch (e) {
            console.log('Ошибка в очереди подключений:', e.message);
        }
    }
    
    isProcessingQueue = false;
}

// Добавление в очередь подключений
function addToConnectionQueue(token, index, retryCount = 0) {
    connectionQueue.push({ token, index, retryCount });
    
    if (!isProcessingQueue) {
        setTimeout(processConnectionQueue, 100);
    }
}

function createBotFromToken(token, botIndex, retryCount = 0) {
    return new Promise((resolve) => {
        let botCreated = false;
        let connectionWatchdog = null;
        
        try {
            const cleanToken = token.includes(' - ') ? token.split(' - ')[1].trim() : token.trim();
            const payload = JSON.parse(Buffer.from(cleanToken.split('.')[1], 'base64').toString());
            const username = payload.pfd[0].name;
            const uuid = payload.pfd[0].id.replace(/-/g, '');
            const expiryTime = payload.exp * 1000;

            // Получаем прокси с ротацией
            const proxyUrl = getNextProxy();
            if (!proxyUrl) {
                console.log(`[${username}] Нет доступных прокси`);
                resolve(false);
                return;
            }

            // Инициализируем данные бота если их нет
            if (!activeBots[username]) {
                activeBots[username] = { 
                    status: '🔌 Подключение...', 
                    online: false, 
                    error: false,
                    shards: 0,
                    spawners: 0,
                    proxy: proxyUrl.split('@')[1]?.split(':')[0] || "Proxy", 
                    isAfk: false,
                    isBuying: false,
                    isCollecting: false,
                    expires: expiryTime,
                    botInstance: null,
                    reconnectAttempts: 0,
                    lastConnectAttempt: Date.now()
                };
            } else {
                // Проверяем, не пытались ли мы подключиться недавно
                const timeSinceLastAttempt = Date.now() - (activeBots[username].lastConnectAttempt || 0);
                if (timeSinceLastAttempt < 30000) { // 30 секунд между попытками
                    console.log(`[${username}] Слишком частые попытки подключения`);
                    setTimeout(() => {
                        addToConnectionQueue(token, botIndex, retryCount);
                    }, 30000 - timeSinceLastAttempt);
                    resolve(false);
                    return;
                }
                
                // Обновляем статус для существующего бота
                activeBots[username].status = '🔌 Подключение...';
                activeBots[username].online = false;
                activeBots[username].error = false;
                activeBots[username].reconnectAttempts = (activeBots[username].reconnectAttempts || 0) + 1;
                activeBots[username].lastConnectAttempt = Date.now();
            }

            console.log(`[${username}] Подключение через прокси: ${proxyUrl.split('@')[1] || 'unknown'}`);

            const bot = mineflayer.createBot({
                host: 'donutsmp.net',
                port: 25565,
                version: '1.21.2',
                username: username,
                session: { 
                    accessToken: cleanToken, 
                    clientToken: uuid, 
                    selectedProfile: { 
                        id: uuid, 
                        name: username 
                    } 
                },
                auth: 'mojang',
                agent: new ProxyAgent(proxyUrl),
                skipValidation: true,
                connectTimeout: 45000,
                checkTimeoutInterval: 45000,
                hideErrors: true,
                viewDistance: 'tiny',
                chatLengthLimit: 256,
                colorsEnabled: false
            });

            connectionWatchdog = setTimeout(() => {
                if (!botCreated) {
                    console.log(`[${username}] Таймаут подключения`);
                    activeBots[username].status = '⏱️ Таймаут подключения';
                    activeBots[username].error = true;
                    
                    try {
                        if (bot && bot.quit) bot.quit();
                    } catch (e) {}
                    
                    // Пытаемся переподключиться
                    if (Date.now() < expiryTime && retryCount < 3) {
                        setTimeout(() => {
                            addToConnectionQueue(token, botIndex, retryCount + 1);
                        }, 30000);
                    }
                    resolve(false);
                }
            }, 50000);

            activeBots[username].botInstance = bot;

            // Сохранение сессии
            const botPath = path.join(SESSIONS_DIR, username);
            if (!fs.existsSync(botPath)) fs.mkdirSync(botPath, { recursive: true });
            fs.writeFileSync(path.join(botPath, 'mca-cache.json'), JSON.stringify({ 
                accessToken: cleanToken,
                uuid: uuid,
                username: username,
                expires: expiryTime
            }));

            // Обработчик успешного подключения
            bot.once('spawn', () => {
                botCreated = true;
                if (connectionWatchdog) clearTimeout(connectionWatchdog);
                
                console.log(`[${username}] Успешно подключен`);
                activeBots[username].status = '🌍 В сети';
                activeBots[username].online = true;
                activeBots[username].error = false;
                activeBots[username].reconnectAttempts = 0;

                // Обновляем инвентарь при изменении
                bot.inventory.on('updateSlot', () => refreshSpawnerCount(bot, username));

                // Интервал для проверки шардов
                const shardInterval = setInterval(() => {
                    if (bot.entity && 
                        !activeBots[username].isBuying && 
                        !activeBots[username].isCollecting && 
                        bot.health > 0) {
                        bot.chat('/shards');
                    }
                }, 180000);

                // Начальные действия после спауна
                setTimeout(async () => {
                    if (!bot.entity || bot.health <= 0) return;
                    
                    try {
                        bot.chat('/shards');
                        await sleep(5000); 
                        refreshSpawnerCount(bot, username);
                        
                        if (activeBots[username].shards >= 500) {
                            setTimeout(() => {
                                buySpawner(bot, username);
                            }, 3000);
                        }
                        
                        if (!activeBots[username].isCollecting) {
                            setTimeout(() => {
                                goToAfk(bot, username);
                            }, 5000);
                        }
                    } catch (e) {
                        console.log(`[${username}] Ошибка в стартовых действиях:`, e.message);
                    }
                }, 10000);

                // Очистка интервала при отключении
                bot.once('end', () => {
                    clearInterval(shardInterval);
                });
                
                resolve(true);
            });

            // Обработчик сообщений чата
            bot.on('message', (m) => {
                try {
                    const txt = m.toString();
                    const shardMatch = txt.match(/Your shard[s]?[:]?\s?([\d,]+)/i);
                    
                    if (shardMatch) {
                        const shards = parseInt(shardMatch[1].replace(/,/g, ''));
                        activeBots[username].shards = shards;
                        
                        if (shards >= 500 && 
                            !activeBots[username].isBuying && 
                            !activeBots[username].isCollecting && 
                            activeBots[username].isAfk) {
                            // Запускаем покупку с небольшой задержкой
                            setTimeout(() => {
                                buySpawner(bot, username);
                            }, 3000);
                        }
                    }
                } catch (e) {
                    // Игнорируем ошибки парсинга сообщений
                }
            });

            // Обработчик ошибок с улучшенной логикой
            bot.on('error', (err) => {
                console.log(`[${username}] Ошибка бота:`, err.code || err.message);
                
                if (connectionWatchdog) clearTimeout(connectionWatchdog);
                
                activeBots[username].error = true;
                activeBots[username].online = false;
                botCreated = false;
                
                // Игнорируем некоторые ошибки
                const ignorableErrors = [
                    'ECONNABORTED', 
                    'ECONNRESET', 
                    'ETIMEDOUT', 
                    'EPIPE',
                    'EHOSTUNREACH',
                    'ENOTFOUND'
                ];
                
                if (ignorableErrors.includes(err.code)) {
                    console.log(`[${username}] Сетевая ошибка (${err.code}), переподключение...`);
                    activeBots[username].status = `🔌 Ошибка сети (${err.code})`;
                } else {
                    activeBots[username].status = `❌ Ошибка: ${err.code || err.message.substring(0, 30)}`;
                }
                
                // Пытаемся переподключиться если сессия еще действует
                if (Date.now() < expiryTime && retryCount < 3) {
                    setTimeout(() => {
                        addToConnectionQueue(token, botIndex, retryCount + 1);
                    }, 30000);
                }
                
                resolve(false);
            });

            // Обработчик отключения
            bot.on('end', (reason) => {
                console.log(`[${username}] Отключен:`, reason || 'Неизвестная причина');
                
                if (connectionWatchdog) clearTimeout(connectionWatchdog);
                
                activeBots[username].online = false;
                
                if (Date.now() < expiryTime) {
                    if (activeBots[username].reconnectAttempts < 5) {
                        console.log(`[${username}] Планирую переподключение...`);
                        activeBots[username].status = '🔄 Переподключение...';
                        
                        // Задержка перед переподключением
                        setTimeout(() => {
                            addToConnectionQueue(token, botIndex, retryCount + 1);
                        }, 30000);
                    } else {
                        activeBots[username].status = '💀 Слишком много переподключений';
                    }
                } else {
                    activeBots[username].status = '💀 Сессия истекла';
                }
                
                resolve(false);
            });

        } catch (e) { 
            console.log(`[Ошибка старта] ${e.message}`);
            
            // Пытаемся переподключиться при ошибке инициализации
            if (username && token && retryCount < 3) {
                setTimeout(() => {
                    addToConnectionQueue(token, botIndex, retryCount + 1);
                }, 10000);
            }
            
            resolve(false);
        }
    });
}

// Статистика для отображения
let serverStats = {
    totalAccounts: 0,
    accountsInFile: 0,
    totalShards: 0,
    totalSpawners: 0,
    online: 0,
    errors: 0,
    offline: 0,
    buying: 0,
    collecting: 0,
    afk: 0
};

// Функция обновления статистики
function updateStats() {
    const stats = {
        totalAccounts: Object.keys(activeBots).length,
        accountsInFile: loadAccountsFromFile().length,
        totalShards: 0,
        totalSpawners: 0,
        online: 0,
        errors: 0,
        offline: 0,
        buying: 0,
        collecting: 0,
        afk: 0
    };
    
    for (const [username, botData] of Object.entries(activeBots)) {
        stats.totalShards += (botData.shards || 0);
        stats.totalSpawners += (botData.spawners || 0);
        
        if (botData.error) stats.errors++;
        else if (botData.online) stats.online++;
        else stats.offline++;
        
        if (botData.isBuying) stats.buying++;
        if (botData.isCollecting) stats.collecting++;
        if (botData.isAfk) stats.afk++;
    }
    
    serverStats = stats;
    return stats;
}

// Функция для добавления партии аккаунтов
async function addBatch(batchNumber, totalBatches) {
    if (!progress.isAdding) return;
    
    const startIdx = (batchNumber - 1) * config.batchSize;
    const endIdx = Math.min(startIdx + config.batchSize, progress.total);
    const batch = progress.accountsQueue.slice(startIdx, endIdx);
    
    console.log(`Добавляю партию ${batchNumber}/${totalBatches}: ${batch.length} аккаунтов`);
    
    progress.currentBatch = batchNumber;
    saveProgress();
    
    // Добавляем аккаунты из этой партии
    for (let i = 0; i < batch.length; i++) {
        if (!progress.isAdding) break;
        
        const line = batch[i];
        addToConnectionQueue(line.trim(), progress.added + i);
        
        // Задержка между аккаунтами
        await sleep(config.delayBetweenAccounts);
    }
    
    progress.added += batch.length;
    progress.pending = progress.total - progress.added;
    progress.lastAdded = Date.now();
    saveProgress();
    
    // Если есть еще аккаунты, планируем следующую партию
    if (progress.added < progress.total && progress.isAdding) {
        console.log(`Планирую следующую партию через ${config.delayBetweenBatches/1000} сек.`);
        
        setTimeout(() => {
            addBatch(batchNumber + 1, totalBatches);
        }, config.delayBetweenBatches);
    } else {
        // Все аккаунты добавлены
        progress.isAdding = false;
        progress.accountsQueue = [];
        saveProgress();
        console.log('Все аккаунты добавлены!');
    }
}

// Функция для начала добавления аккаунтов
function startAddingAccounts(accountsText) {
    const lines = accountsText.split('\n').filter(l => l.trim());
    const totalLines = lines.length;
    const savedCount = saveAccountsToFile(accountsText);
    
    console.log(`Загружено ${totalLines} аккаунтов, сохранено ${savedCount} новых`);
    
    // Инициализируем прогресс
    progress.total = totalLines;
    progress.added = 0;
    progress.pending = totalLines;
    progress.currentBatch = 0;
    progress.totalBatches = Math.ceil(totalLines / config.batchSize);
    progress.isAdding = true;
    progress.lastAdded = Date.now();
    progress.accountsQueue = lines;
    saveProgress();
    
    // Начинаем добавление первой партии
    addBatch(1, progress.totalBatches);
    
    return { 
        total: totalLines, 
        saved: savedCount,
        batches: progress.totalBatches,
        message: `Начато добавление ${totalLines} аккаунтов (${progress.totalBatches} партий)`
    };
}

// Функция для продолжения добавления аккаунтов
function continueAddingAccounts() {
    if (!progress.isAdding && progress.pending > 0) {
        progress.isAdding = true;
        saveProgress();
        
        const currentBatch = Math.floor(progress.added / config.batchSize) + 1;
        const totalBatches = progress.totalBatches;
        
        console.log(`Продолжаю добавление с партии ${currentBatch}/${totalBatches}`);
        
        addBatch(currentBatch, totalBatches);
        
        return { 
            success: true, 
            message: `Продолжено добавление с партии ${currentBatch}/${totalBatches}` 
        };
    }
    
    return { 
        success: false, 
        message: 'Нет аккаунтов для добавления или уже идет процесс' 
    };
}

// Функция для остановки добавления
function stopAddingAccounts() {
    progress.isAdding = false;
    saveProgress();
    
    return { 
        success: true, 
        message: 'Добавление аккаунтов остановлено' 
    };
}

// Загрузка сессий при старте
function loadSessions() {
    try {
        const savedFolders = fs.readdirSync(SESSIONS_DIR).filter(f => 
            fs.lstatSync(path.join(SESSIONS_DIR, f)).isDirectory()
        );
        
        console.log(`Найдено сохраненных сессий: ${savedFolders.length}`);
        
        // Ограничиваем количество одновременно загружаемых сессий
        const maxConcurrent = 10;
        let currentIndex = 0;
        
        function loadBatch() {
            const batch = savedFolders.slice(currentIndex, currentIndex + maxConcurrent);
            currentIndex += maxConcurrent;
            
            batch.forEach((name, i) => {
                const cachePath = path.join(SESSIONS_DIR, name, 'mca-cache.json');
                if (fs.existsSync(cachePath)) {
                    const delay = i * 5000; // 5 секунд между ботами в батче
                    
                    setTimeout(() => {
                        try {
                            const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                            
                            if (data.expires && Date.now() < data.expires) {
                                addToConnectionQueue(data.accessToken, i);
                            }
                        } catch (e) {
                            console.log(`[${name}] Ошибка загрузки сессии:`, e.message);
                        }
                    }, delay);
                }
            });
            
            if (currentIndex < savedFolders.length) {
                setTimeout(loadBatch, 30000); // Следующий батч через 30 секунд
            }
        }
        
        loadBatch();
    } catch (e) {
        console.log('Ошибка загрузки сессий:', e.message);
    }
}

// Запускаем загрузку сессий с задержкой
setTimeout(loadSessions, 5000);

// Функция для принудительного переподключения всех ботов
function reconnectAllBots() {
    console.log('Принудительное переподключение всех ботов...');
    let count = 0;
    
    for (const [username, botData] of Object.entries(activeBots)) {
        // Загружаем токен из сохраненной сессии
        const cachePath = path.join(SESSIONS_DIR, username, 'mca-cache.json');
        if (fs.existsSync(cachePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                
                // Отключаем текущего бота если он есть
                if (botData.botInstance && botData.botInstance.quit) {
                    try {
                        botData.botInstance.quit();
                    } catch (e) {}
                }
                
                // Запускаем нового с задержкой
                setTimeout(() => {
                    addToConnectionQueue(data.accessToken, count);
                }, count * 5000);
                
                count++;
            } catch (e) {
                console.log(`[${username}] Ошибка при переподключении:`, e.message);
            }
        }
    }
    
    return { success: true, count };
}

// API Эндпоинты
app.post('/collect-cmd', (req, res) => {
    const { botName, target } = req.body;
    const botData = activeBots[botName];
    if (botData && botData.botInstance && botData.online) {
        startCollect(botData.botInstance, botName, target || config.defaultTpNick);
        res.json({ ok: true });
    } else res.status(404).json({ error: 'Бот не найден или не в сети' });
});

app.post('/collect-all', (req, res) => {
    const { target } = req.body;
    const result = collectAllBotsWithSpawners(target || config.defaultTpNick);
    res.json(result);
});

app.post('/add-bulk', async (req, res) => {
    try {
        const { text } = req.body;
        
        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: 'Пустой текст' });
        }
        
        console.log('Получен запрос на добавление аккаунтов, длина текста:', text.length);
        
        // Обрабатываем асинхронно и сразу возвращаем ответ
        const result = startAddingAccounts(text);
        
        res.json({ 
            ok: true, 
            message: result.message,
            total: result.total,
            batches: result.batches
        });
        
    } catch (e) {
        console.error('Ошибка в /add-bulk:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/continue-adding', (req, res) => {
    try {
        const result = continueAddingAccounts();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/stop-adding', (req, res) => {
    try {
        const result = stopAddingAccounts();
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/add-from-file', (req, res) => {
    try {
        const accounts = loadAccountsFromFile();
        const result = startAddingAccounts(accounts.join('\n'));
        
        res.json({ 
            ok: true, 
            message: 'Аккаунты из файла начали добавляться',
            count: accounts.length,
            batches: result.batches
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/accounts-file-info', (req, res) => {
    try {
        const accounts = loadAccountsFromFile();
        res.json({ 
            count: accounts.length,
            accounts: accounts.slice(0, 10)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/progress', (req, res) => {
    res.json(progress);
});

app.post('/clear-accounts-file', (req, res) => {
    try {
        fs.writeFileSync(ACCOUNTS_FILE, '');
        res.json({ ok: true, message: 'Файл аккаунтов очищен' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/update-config', (req, res) => {
    try {
        const newConfig = req.body;
        
        if (newConfig.theme) {
            config.theme = { ...config.theme, ...newConfig.theme };
        }
        if (newConfig.defaultTpNick !== undefined) {
            config.defaultTpNick = newConfig.defaultTpNick;
        }
        if (newConfig.autoCollectThreshold !== undefined) {
            config.autoCollectThreshold = parseInt(newConfig.autoCollectThreshold) || 1;
        }
        if (newConfig.batchSize !== undefined) {
            config.batchSize = parseInt(newConfig.batchSize) || 100;
        }
        if (newConfig.delayBetweenBatches !== undefined) {
            config.delayBetweenBatches = parseInt(newConfig.delayBetweenBatches) || 60000;
        }
        if (newConfig.delayBetweenAccounts !== undefined) {
            config.delayBetweenAccounts = parseInt(newConfig.delayBetweenAccounts) || 10000;
        }
        
        saveConfig();
        res.json({ ok: true, config });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post('/reconnect-all', (req, res) => {
    const result = reconnectAllBots();
    res.json(result);
});

app.post('/reconnect-bot', (req, res) => {
    const { botName } = req.body;
    const botData = activeBots[botName];
    
    if (!botData) {
        return res.status(404).json({ error: 'Бот не найден' });
    }
    
    const cachePath = path.join(SESSIONS_DIR, botName, 'mca-cache.json');
    if (fs.existsSync(cachePath)) {
        try {
            const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            
            // Отключаем текущего бота если он есть
            if (botData.botInstance && botData.botInstance.quit) {
                try {
                    botData.botInstance.quit();
                } catch (e) {}
            }
            
            // Запускаем нового
            setTimeout(() => {
                addToConnectionQueue(data.accessToken, 0);
            }, 1000);
            
            res.json({ ok: true, message: 'Переподключение запущено' });
            
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    } else {
        res.status(404).json({ error: 'Сохраненная сессия не найдена' });
    }
});

app.get('/config', (req, res) => {
    res.json(config);
});

app.get('/proxies', (req, res) => {
    const proxies = getProxies();
    res.json({ 
        count: proxies.length, 
        proxies: proxies.map(p => p.split('@')[1] || p) 
    });
});

app.get('/status', (req, res) => {
    const data = {};
    for (let name in activeBots) {
        const { botInstance, ...info } = activeBots[name];
        data[name] = info;
    }
    res.json(data);
});

app.get('/stats', (req, res) => {
    const stats = updateStats();
    res.json({
        ...stats,
        connectionQueue: connectionQueue.length,
        isProcessingQueue: isProcessingQueue
    });
});

app.get('/server-status', (req, res) => {
    const stats = updateStats();
    
    res.json({
        ...stats,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        connectionQueue: connectionQueue.length
    });
});

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>DONUT SMP FARM PRO</title>
            <style>
                :root {
                    --primary: ${config.theme.primary};
                    --secondary: ${config.theme.secondary};
                    --background: ${config.theme.background};
                    --text: ${config.theme.text};
                    --accent: ${config.theme.accent};
                }
                
                body {
                    font-family: 'Segoe UI', sans-serif;
                    background: var(--background);
                    color: var(--text);
                    padding: 20px;
                    margin: 0;
                    transition: all 0.3s;
                }
                
                .container {
                    max-width: 1400px;
                    margin: 0 auto;
                }
                
                .header {
                    text-align: center;
                    margin-bottom: 20px;
                    background: var(--secondary);
                    padding: 20px;
                    border-radius: 15px;
                    border: 1px solid #222;
                }
                
                .stats {
                    display: flex;
                    justify-content: center;
                    gap: 15px;
                    margin-top: 15px;
                    font-size: 14px;
                    flex-wrap: wrap;
                }
                
                .stat-item {
                    padding: 8px 15px;
                    border-radius: 10px;
                    background: rgba(0,0,0,0.3);
                    min-width: 100px;
                    text-align: center;
                }
                
                .main-content {
                    display: flex;
                    gap: 20px;
                    margin-top: 20px;
                    flex-wrap: wrap;
                }
                
                .panel {
                    background: var(--secondary);
                    padding: 20px;
                    border-radius: 12px;
                    border: 1px solid #222;
                }
                
                .left-panel {
                    width: 380px;
                    min-width: 380px;
                }
                
                .right-panel {
                    flex-grow: 1;
                    max-height: 70vh;
                    overflow-y: auto;
                }
                
                textarea {
                    width: 100%;
                    height: 200px;
                    background: #000;
                    color: #0f0;
                    border: 1px solid #333;
                    font-family: monospace;
                    font-size: 11px;
                    padding: 10px;
                    box-sizing: border-box;
                    outline: none;
                    border-radius: 5px;
                    resize: vertical;
                }
                
                button {
                    padding: 10px 15px;
                    background: var(--primary);
                    color: white;
                    border: none;
                    cursor: pointer;
                    border-radius: 6px;
                    font-weight: bold;
                    transition: opacity 0.2s;
                    font-size: 14px;
                }
                
                button:hover {
                    opacity: 0.9;
                }
                
                button.secondary {
                    background: #333;
                }
                
                button.danger {
                    background: #f44336;
                }
                
                button.warning {
                    background: #FF9800;
                }
                
                button.info {
                    background: #2196F3;
                }
                
                button.success {
                    background: #4CAF50;
                }
                
                .bot-card {
                    margin-bottom: 10px;
                    padding: 12px;
                    background: #181818;
                    border-radius: 8px;
                    border-left: 4px solid;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    transition: transform 0.2s;
                }
                
                .bot-card:hover {
                    transform: translateY(-2px);
                }
                
                .bot-info {
                    flex-grow: 1;
                }
                
                .bot-stats {
                    text-align: right;
                    min-width: 160px;
                }
                
                .modal {
                    display: none;
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0,0,0,0.8);
                    z-index: 1000;
                    align-items: center;
                    justify-content: center;
                }
                
                .modal-content {
                    background: var(--secondary);
                    padding: 30px;
                    border-radius: 15px;
                    max-width: 500px;
                    width: 90%;
                    max-height: 80vh;
                    overflow-y: auto;
                }
                
                .form-group {
                    margin-bottom: 15px;
                }
                
                label {
                    display: block;
                    margin-bottom: 5px;
                    color: #aaa;
                }
                
                input, select {
                    width: 100%;
                    padding: 8px;
                    background: #000;
                    border: 1px solid #333;
                    color: var(--text);
                    border-radius: 4px;
                }
                
                .color-input {
                    display: flex;
                    gap: 10px;
                    align-items: center;
                }
                
                .color-input input[type="color"] {
                    width: 40px;
                    height: 40px;
                    padding: 0;
                }
                
                .action-buttons {
                    display: flex;
                    gap: 10px;
                    margin-top: 10px;
                    flex-wrap: wrap;
                }
                
                .proxy-info {
                    font-size: 12px;
                    color: #777;
                    margin-top: 5px;
                }
                
                .status-dot {
                    display: inline-block;
                    width: 10px;
                    height: 10px;
                    border-radius: 50%;
                    margin-right: 5px;
                }
                
                .status-online { background: #4CAF50; }
                .status-error { background: #f44336; }
                .status-offline { background: #777; }
                .status-afk { background: #2196F3; }
                .status-buying { background: #9c27b0; }
                .status-collecting { background: #FF9800; }
                .status-adding { background: #FF9800; }
                
                .tab-buttons {
                    display: flex;
                    gap: 5px;
                    margin-bottom: 15px;
                    border-bottom: 1px solid #333;
                    padding-bottom: 10px;
                }
                
                .tab-button {
                    padding: 8px 15px;
                    background: #222;
                    border: none;
                    color: #aaa;
                    cursor: pointer;
                    border-radius: 5px 5px 0 0;
                    transition: all 0.3s;
                }
                
                .tab-button.active {
                    background: var(--primary);
                    color: white;
                }
                
                .tab-content {
                    display: none;
                }
                
                .tab-content.active {
                    display: block;
                }
                
                .progress-container {
                    margin: 15px 0;
                    padding: 15px;
                    background: rgba(0,0,0,0.2);
                    border-radius: 8px;
                    border: 1px solid #333;
                }
                
                .progress-bar {
                    width: 100%;
                    height: 20px;
                    background: #222;
                    border-radius: 10px;
                    overflow: hidden;
                    margin: 10px 0;
                }
                
                .progress-fill {
                    height: 100%;
                    background: var(--primary);
                    transition: width 0.3s;
                }
                
                .progress-info {
                    display: flex;
                    justify-content: space-between;
                    font-size: 12px;
                    color: #aaa;
                }
                
                .queue-info {
                    font-size: 12px;
                    color: #FF9800;
                    margin-top: 10px;
                    padding: 5px;
                    background: rgba(255,152,0,0.1);
                    border-radius: 5px;
                }
                
                .batch-controls {
                    display: flex;
                    gap: 10px;
                    margin-top: 15px;
                    flex-wrap: wrap;
                }
                
                @media (max-width: 768px) {
                    .main-content {
                        flex-direction: column;
                    }
                    .left-panel, .right-panel {
                        width: 100%;
                    }
                    .stats {
                        gap: 8px;
                    }
                    .stat-item {
                        min-width: 80px;
                        padding: 6px 10px;
                        font-size: 12px;
                    }
                    .left-panel {
                        min-width: 100%;
                    }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h2 style="color:var(--primary); margin:0; letter-spacing: 2px;">DONUT SMP FARM PRO</h2>
                    <div class="stats" id="global-stats">
                        <div class="stat-item">Всего: <b id="stat-total">0</b></div>
                        <div class="stat-item" style="color:var(--primary);"><span class="status-dot status-online"></span>В сети: <b id="stat-on">0</b></div>
                        <div class="stat-item" style="color:#f44336;"><span class="status-dot status-error"></span>Ошибки: <b id="stat-err">0</b></div>
                        <div class="stat-item" style="color:#2196F3;"><span class="status-dot status-afk"></span>AFK: <b id="stat-afk">0</b></div>
                        <div class="stat-item" style="color:#9c27b0;"><span class="status-dot status-buying"></span>Покупают: <b id="stat-buying">0</b></div>
                        <div class="stat-item" style="color:#FF9800;"><span class="status-dot status-collecting"></span>Собирают: <b id="stat-collecting">0</b></div>
                    </div>
                    <div style="margin-top:10px; font-size:12px;">
                        💎 Общие шарды: <span id="total-shards" style="color:var(--accent);">0</span> | 
                        📦 Общие спавнеры: <span id="total-spawners" style="color:#ff9800;">0</span> |
                        🔄 В очереди: <span id="queue-size" style="color:#FF9800;">0</span>
                    </div>
                    <div class="proxy-info" id="proxy-info">
                        Прокси: загружается...
                    </div>
                </div>

                <div class="action-buttons" style="justify-content: center; margin-bottom: 20px;">
                    <button onclick="collectAll()" class="warning">
                        📦 СБОР ВСЕХ (≥${config.autoCollectThreshold} спавнера)
                    </button>
                    <button onclick="forceBuyAll()" class="success">
                        💰 КУПИТЬ У ВСЕХ (≥500 шардов)
                    </button>
                    <button onclick="afkAll()" class="info">
                        💤 AFK ВСЕХ
                    </button>
                    <button onclick="reconnectAll()" class="secondary">
                        🔄 ПЕРЕПОДКЛЮЧИТЬ ВСЕХ
                    </button>
                    <button onclick="showSettings()" style="background: #2196F3;">
                        ⚙️ НАСТРОЙКИ
                    </button>
                    <button onclick="location.reload()" style="background: #FF9800;">
                        🔄 ОБНОВИТЬ
                    </button>
                </div>

                <div class="main-content">
                    <div class="panel left-panel">
                        <div class="tab-buttons">
                            <button class="tab-button active" onclick="showTab('add-tab')">➕ Добавить</button>
                            <button class="tab-button" onclick="showTab('progress-tab')">📊 Прогресс</button>
                            <button class="tab-button" onclick="showTab('file-tab')">📁 Из файла</button>
                            <button class="tab-button" onclick="showTab('stats-tab')">📈 Статистика</button>
                        </div>
                        
                        <div id="add-tab" class="tab-content active">
                            <div style="margin-bottom: 15px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                                    <h4 style="margin: 0; color: var(--accent);">Добавить аккаунты</h4>
                                    <span style="font-size: 12px; color: #777;" id="accounts-count">0/5000</span>
                                </div>
                                <textarea id="bulk" placeholder="Ник - Токен
Можно добавлять до 5000 аккаунтов
Формат:
nick1 - token1
nick2 - token2
..."></textarea>
                                
                                <div class="batch-controls">
                                    <button onclick="addBulk()" style="flex-grow: 1;">🚀 НАЧАТЬ ДОБАВЛЕНИЕ</button>
                                    <button onclick="document.getElementById('bulk').value = ''" class="secondary">✖️</button>
                                </div>
                                
                                <div style="margin-top: 10px; font-size: 11px; color: #777;">
                                    Аккаунты добавляются партиями по ${config.batchSize} с задержкой ${config.delayBetweenBatches/1000} сек. между партиями
                                </div>
                            </div>
                        </div>
                        
                        <div id="progress-tab" class="tab-content">
                            <div style="margin-bottom: 15px;">
                                <h4 style="margin: 0 0 10px 0; color: var(--accent);">📊 Прогресс добавления</h4>
                                
                                <div class="progress-container" id="progress-container" style="display: none;">
                                    <div style="display: flex; justify-content: space-between; align-items: center;">
                                        <span id="progress-status">Добавление не активно</span>
                                        <span class="status-dot status-adding" id="progress-status-dot"></span>
                                    </div>
                                    
                                    <div class="progress-bar">
                                        <div class="progress-fill" id="progress-fill" style="width: 0%"></div>
                                    </div>
                                    
                                    <div class="progress-info">
                                        <span>Добавлено: <b id="progress-added">0</b> / <b id="progress-total">0</b></span>
                                        <span>Осталось: <b id="progress-pending">0</b></span>
                                    </div>
                                    
                                    <div class="progress-info">
                                        <span>Партия: <b id="progress-batch">0</b> / <b id="progress-total-batches">0</b></span>
                                        <span>В очереди: <b id="progress-queue">0</b></span>
                                    </div>
                                    
                                    <div class="batch-controls">
                                        <button onclick="continueAdding()" class="success" id="continue-btn" style="display: none;">▶️ ПРОДОЛЖИТЬ</button>
                                        <button onclick="stopAdding()" class="danger" id="stop-btn" style="display: none;">⏹️ ОСТАНОВИТЬ</button>
                                    </div>
                                </div>
                                
                                <div id="no-progress" style="text-align: center; padding: 20px; color: #777;">
                                    Нет активного процесса добавления
                                </div>
                            </div>
                        </div>
                        
                        <div id="file-tab" class="tab-content">
                            <div style="margin-bottom: 15px;">
                                <h4 style="margin: 0 0 10px 0; color: var(--accent);">📁 Управление файлом аккаунтов</h4>
                                <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 5px; margin-bottom: 15px;">
                                    <div style="font-size: 12px;">
                                        <div>Аккаунтов в файле: <span id="file-accounts-count">0</span></div>
                                        <div style="margin-top: 5px;">Файл: <code>accounts.txt</code></div>
                                    </div>
                                </div>
                                <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                                    <button onclick="loadFromFile()" class="success">📂 Загрузить из файла</button>
                                    <button onclick="clearAccountsFile()" class="danger">🗑️ Очистить файл</button>
                                    <button onclick="downloadAccountsFile()" class="info">⬇️ Скачать файл</button>
                                </div>
                                <div style="margin-top: 15px; font-size: 11px; color: #777;">
                                    При добавлении через текстовое поле аккаунты автоматически сохраняются в файл
                                </div>
                            </div>
                        </div>
                        
                        <div id="stats-tab" class="tab-content">
                            <div style="margin-bottom: 15px;">
                                <h4 style="margin: 0 0 10px 0; color: var(--accent); font-size: 14px;">📈 Статистика сервера</h4>
                                <div style="font-size: 12px; line-height: 1.6;">
                                    <div>Uptime: <span id="server-uptime">0</span>s</div>
                                    <div>RAM: <span id="server-ram">0</span>MB</div>
                                    <div>Прокси: <span id="proxy-count">0</span></div>
                                    <div>Ошибок: <span id="server-errors">0</span></div>
                                    <div>Активных: <span id="server-active">0</span></div>
                                    <div>В файле: <span id="server-file-count">0</span></div>
                                    <div>В очереди: <span id="server-queue">0</span></div>
                                </div>
                            </div>
                            
                            <div style="margin-top: 15px; padding: 10px; background: rgba(0,255,0,0.1); border-radius: 5px; border: 1px solid #4CAF50;">
                                <small style="color: #4CAF50;">✅ Для больших объемов:</small><br>
                                <small style="color: #777; font-size: 10px;">
                                    1. Добавляйте аккаунты партиями по ${config.batchSize}<br>
                                    2. Делайте перерывы между партиями<br>
                                    3. Можно останавливать и продолжать<br>
                                    4. Прогресс сохраняется при перезагрузке
                                </small>
                            </div>
                        </div>
                    </div>
                    <div class="panel right-panel" id="list"></div>
                </div>
            </div>

            <!-- Модальное окно настроек -->
            <div id="settingsModal" class="modal">
                <div class="modal-content">
                    <h3 style="margin-top: 0; color: var(--primary);">⚙️ НАСТРОЙКИ</h3>
                    
                    <div class="form-group">
                        <label>Ник для TP по умолчанию:</label>
                        <input type="text" id="config-tp-nick" value="${config.defaultTpNick}">
                    </div>
                    
                    <div class="form-group">
                        <label>Порог для автособора (спавнеров):</label>
                        <input type="number" id="config-threshold" value="${config.autoCollectThreshold}" min="1" max="100">
                    </div>
                    
                    <h4 style="color: var(--accent); margin-top: 20px;">⚙️ Настройки добавления</h4>
                    
                    <div class="form-group">
                        <label>Размер партии (аккаунтов):</label>
                        <input type="number" id="config-batch-size" value="${config.batchSize}" min="10" max="500">
                    </div>
                    
                    <div class="form-group">
                        <label>Задержка между партиями (секунд):</label>
                        <input type="number" id="config-batch-delay" value="${config.delayBetweenBatches/1000}" min="10" max="300">
                    </div>
                    
                    <div class="form-group">
                        <label>Задержка между аккаунтами (секунд):</label>
                        <input type="number" id="config-account-delay" value="${config.delayBetweenAccounts/1000}" min="1" max="30">
                    </div>
                    
                    <h4 style="color: var(--accent); margin-top: 20px;">🎨 Цветовая тема</h4>
                    
                    <div class="form-group">
                        <div class="color-input">
                            <label>Основной цвет:</label>
                            <input type="color" id="config-primary" value="${config.theme.primary}">
                            <input type="text" id="config-primary-text" value="${config.theme.primary}" style="flex-grow: 1;">
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <div class="color-input">
                            <label>Фон панелей:</label>
                            <input type="color" id="config-secondary" value="${config.theme.secondary}">
                            <input type="text" id="config-secondary-text" value="${config.theme.secondary}" style="flex-grow: 1;">
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <div class="color-input">
                            <label>Акцентный цвет:</label>
                            <input type="color" id="config-accent" value="${config.theme.accent}">
                            <input type="text" id="config-accent-text" value="${config.theme.accent}" style="flex-grow: 1;">
                        </div>
                    </div>
                    
                    <div class="action-buttons">
                        <button onclick="saveSettings()">💾 СОХРАНИТЬ</button>
                        <button onclick="closeSettings()" class="secondary">✖️ ОТМЕНА</button>
                        <button onclick="resetSettings()" class="danger">🔄 СБРОС</button>
                    </div>
                </div>
            </div>

            <script>
                let config = ${JSON.stringify(config)};
                let globalStats = {};
                let currentProgress = {};
                
                function showTab(tabId) {
                    document.querySelectorAll('.tab-content').forEach(tab => {
                        tab.classList.remove('active');
                    });
                    document.querySelectorAll('.tab-button').forEach(btn => {
                        btn.classList.remove('active');
                    });
                    
                    document.getElementById(tabId).classList.add('active');
                    event.target.classList.add('active');
                }
                
                function showSettings() {
                    document.getElementById('settingsModal').style.display = 'flex';
                }
                
                function closeSettings() {
                    document.getElementById('settingsModal').style.display = 'none';
                }
                
                function saveSettings() {
                    const newConfig = {
                        theme: {
                            primary: document.getElementById('config-primary').value,
                            secondary: document.getElementById('config-secondary').value,
                            background: config.theme.background,
                            text: config.theme.text,
                            accent: document.getElementById('config-accent').value
                        },
                        defaultTpNick: document.getElementById('config-tp-nick').value,
                        autoCollectThreshold: parseInt(document.getElementById('config-threshold').value) || 1,
                        batchSize: parseInt(document.getElementById('config-batch-size').value) || 100,
                        delayBetweenBatches: (parseInt(document.getElementById('config-batch-delay').value) || 60) * 1000,
                        delayBetweenAccounts: (parseInt(document.getElementById('config-account-delay').value) || 10) * 1000
                    };
                    
                    fetch('/update-config', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify(newConfig)
                    }).then(r => r.json()).then(data => {
                        if (data.ok) {
                            location.reload();
                        } else {
                            alert('Ошибка сохранения настроек');
                        }
                    });
                }
                
                function resetSettings() {
                    if (confirm('Сбросить настройки к значениям по умолчанию?')) {
                        fetch('/update-config', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify(${JSON.stringify(defaultConfig)})
                        }).then(r => r.json()).then(data => {
                            if (data.ok) {
                                location.reload();
                            }
                        });
                    }
                }
                
                function forceBuyAll() {
                    if (confirm('Запустить покупку спавнеров у всех ботов с балансом ≥500 шардов?')) {
                        fetch('/force-buy', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({})
                        }).then(r => r.json()).then(data => {
                            alert('Запущена покупка для ' + data.count + ' ботов');
                        });
                    }
                }
                
                function afkAll() {
                    if (confirm('Отправить всех онлайн ботов в AFK?')) {
                        fetch('/afk-all', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({})
                        }).then(r => r.json()).then(data => {
                            alert('Отправлено в AFK: ' + data.count + ' ботов');
                        });
                    }
                }
                
                function reconnectAll() {
                    if (confirm('Принудительно переподключить всех ботов? Это поможет при проблемах с сетью.')) {
                        fetch('/reconnect-all', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({})
                        }).then(r => r.json()).then(data => {
                            alert('Переподключение запущено для ' + data.count + ' ботов');
                        });
                    }
                }
                
                function reconnectBot(botName) {
                    if (confirm('Переподключить этого бота?')) {
                        fetch('/reconnect-bot', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({botName})
                        }).then(r => r.json()).then(data => {
                            if (data.ok) {
                                alert('Переподключение запущено');
                            } else {
                                alert('Ошибка: ' + data.error);
                            }
                        });
                    }
                }
                
                function continueAdding() {
                    if (confirm('Продолжить добавление аккаунтов?')) {
                        fetch('/continue-adding', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({})
                        }).then(r => r.json()).then(data => {
                            if (data.success) {
                                alert(data.message);
                                updateProgress();
                            } else {
                                alert(data.message);
                            }
                        });
                    }
                }
                
                function stopAdding() {
                    if (confirm('Остановить добавление аккаунтов?')) {
                        fetch('/stop-adding', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({})
                        }).then(r => r.json()).then(data => {
                            if (data.success) {
                                alert(data.message);
                                updateProgress();
                            }
                        });
                    }
                }
                
                function loadFromFile() {
                    if (confirm('Загрузить аккаунты из файла accounts.txt?')) {
                        fetch('/add-from-file', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({})
                        }).then(r => r.json()).then(data => {
                            alert('Загрузка из файла запущена: ' + data.count + ' аккаунтов');
                            updateProgress();
                        });
                    }
                }
                
                function clearAccountsFile() {
                    if (confirm('Очистить файл accounts.txt? Это не удалит уже запущенные аккаунты.')) {
                        fetch('/clear-accounts-file', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({})
                        }).then(r => r.json()).then(data => {
                            if (data.ok) {
                                alert('Файл аккаунтов очищен');
                                updateFileInfo();
                            }
                        });
                    }
                }
                
                function downloadAccountsFile() {
                    fetch('/accounts-file-info')
                        .then(r => r.json())
                        .then(data => {
                            const content = data.accounts.join('\\n');
                            const blob = new Blob([content], { type: 'text/plain' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = 'accounts_backup.txt';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            alert('Файл скачан: ' + data.count + ' аккаунтов');
                        });
                }
                
                function updateFileInfo() {
                    fetch('/accounts-file-info').then(r => r.json()).then(data => {
                        document.getElementById('file-accounts-count').innerText = data.count;
                        document.getElementById('server-file-count').innerText = data.count;
                    });
                }
                
                function updateProgress() {
                    fetch('/progress').then(r => r.json()).then(data => {
                        currentProgress = data;
                        
                        if (data.total > 0) {
                            // Показываем контейнер прогресса
                            document.getElementById('progress-container').style.display = 'block';
                            document.getElementById('no-progress').style.display = 'none';
                            
                            // Обновляем данные
                            const percent = data.total > 0 ? Math.round((data.added / data.total) * 100) : 0;
                            
                            document.getElementById('progress-fill').style.width = percent + '%';
                            document.getElementById('progress-added').innerText = data.added;
                            document.getElementById('progress-total').innerText = data.total;
                            document.getElementById('progress-pending').innerText = data.pending;
                            document.getElementById('progress-batch').innerText = data.currentBatch;
                            document.getElementById('progress-total-batches').innerText = data.totalBatches;
                            document.getElementById('progress-queue').innerText = data.pending;
                            
                            // Обновляем статус
                            if (data.isAdding) {
                                document.getElementById('progress-status').innerText = 'Добавляется...';
                                document.getElementById('progress-status-dot').style.backgroundColor = '#FF9800';
                                document.getElementById('continue-btn').style.display = 'none';
                                document.getElementById('stop-btn').style.display = 'block';
                            } else if (data.pending > 0) {
                                document.getElementById('progress-status').innerText = 'Остановлено';
                                document.getElementById('progress-status-dot').style.backgroundColor = '#f44336';
                                document.getElementById('continue-btn').style.display = 'block';
                                document.getElementById('stop-btn').style.display = 'none';
                            } else {
                                document.getElementById('progress-status').innerText = 'Завершено';
                                document.getElementById('progress-status-dot').style.backgroundColor = '#4CAF50';
                                document.getElementById('continue-btn').style.display = 'none';
                                document.getElementById('stop-btn').style.display = 'none';
                            }
                        } else {
                            // Скрываем контейнер прогресса
                            document.getElementById('progress-container').style.display = 'none';
                            document.getElementById('no-progress').style.display = 'block';
                        }
                    });
                }
                
                // Связываем color inputs с text inputs
                document.addEventListener('DOMContentLoaded', function() {
                    const colorInputs = ['primary', 'secondary', 'accent'];
                    colorInputs.forEach(id => {
                        const color = document.getElementById('config-' + id);
                        const text = document.getElementById('config-' + id + '-text');
                        
                        color.addEventListener('input', () => text.value = color.value);
                        text.addEventListener('input', () => color.value = text.value);
                    });
                    
                    updateProxyInfo();
                    updateFileInfo();
                    updateProgress();
                });
                
                function updateProxyInfo() {
                    fetch('/proxies').then(r => r.json()).then(data => {
                        document.getElementById('proxy-info').innerHTML = 
                            \`Прокси: <b>\${data.count}</b> | Используются: <b>\${Math.min(data.count, globalStats.totalAccounts || 0)}</b>\`;
                        document.getElementById('proxy-count').innerText = data.count;
                    });
                }
                
                function addBulk() {
                    const text = document.getElementById('bulk').value;
                    if(!text) return alert('Введите токены!');
                    
                    const lines = text.split('\\n').filter(l => l.trim());
                    if (lines.length > 5000) {
                        return alert('Слишком много аккаунтов! Максимум 5000.');
                    }
                    
                    fetch('/add-bulk', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({text})
                    }).then(r => r.json()).then(data => {
                        if (data.ok) {
                            alert('Начато добавление ' + data.total + ' аккаунтов (' + data.batches + ' партий)');
                            document.getElementById('bulk').value = '';
                            update();
                            updateProgress();
                        } else {
                            alert('Ошибка: ' + data.error);
                        }
                    }).catch(err => {
                        alert('Сетевая ошибка. Попробуйте снова.');
                    });
                }
                
                function collect(botName) {
                    const target = prompt('Ник для TPA:', config.defaultTpNick);
                    if (target) {
                        fetch('/collect-cmd', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({botName, target})
                        });
                    }
                }
                
                function goAfk(botName) {
                    fetch('/go-afk', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({botName})
                    });
                }
                
                function forceBuy(botName) {
                    fetch('/force-buy-single', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({botName})
                    });
                }
                
                function collectAll() {
                    const target = prompt('Ник для массового TP:', config.defaultTpNick);
                    if (target) {
                        fetch('/collect-all', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({target})
                        }).then(r => r.json()).then(data => {
                            alert('Запущен сбор для ' + data.count + ' ботов');
                        });
                    }
                }
                
                function getTimeLeft(expiry) {
                    const diff = expiry - Date.now();
                    if (diff <= 0) return '<span style="color:#f44336;">Истек</span>';
                    const hours = Math.floor(diff / 3600000);
                    const minutes = Math.floor((diff % 3600000) / 60000);
                    return hours + 'ч ' + minutes + 'м';
                }
                
                function update() {
                    // Запрашиваем общую статистику
                    fetch('/stats').then(r => r.json()).then(stats => {
                        globalStats = stats;
                        
                        // Обновляем глобальную статистику
                        document.getElementById('stat-total').innerText = stats.totalAccounts;
                        document.getElementById('stat-on').innerText = stats.online;
                        document.getElementById('stat-err').innerText = stats.errors;
                        document.getElementById('stat-afk').innerText = stats.afk;
                        document.getElementById('stat-buying').innerText = stats.buying;
                        document.getElementById('stat-collecting').innerText = stats.collecting;
                        document.getElementById('total-shards').innerText = stats.totalShards.toLocaleString();
                        document.getElementById('total-spawners').innerText = stats.totalSpawners;
                        document.getElementById('accounts-count').innerText = stats.totalAccounts + '/5000';
                        document.getElementById('server-active').innerText = stats.online;
                        document.getElementById('server-errors').innerText = stats.errors;
                        document.getElementById('server-queue').innerText = stats.connectionQueue || 0;
                        document.getElementById('queue-size').innerText = stats.connectionQueue || 0;
                    });
                    
                    // Запрашиваем детальный статус ботов
                    fetch('/status').then(r => r.json()).then(data => {
                        const div = document.getElementById('list');
                        div.innerHTML = '';
                        
                        for(const [n, info] of Object.entries(data)) {
                            let color = info.error ? '#f44336' : 
                                      (info.isBuying ? '#9c27b0' :
                                      (info.isCollecting ? '#FF9800' :
                                      (info.online ? (info.isAfk ? '#2196F3' : config.theme.primary) : 
                                      (info.status.includes('Подключение') ? '#FF9800' : '#777'))));
                            
                            let statusColor = info.error ? 'status-error' :
                                            info.isBuying ? 'status-buying' :
                                            info.isCollecting ? 'status-collecting' :
                                            info.online ? (info.isAfk ? 'status-afk' : 'status-online') :
                                            info.status.includes('Подключение') ? 'status-connecting' : 'status-offline';
                            
                            let actionButtons = '';
                            
                            if (info.online && !info.error) {
                                if (!info.isCollecting) {
                                    actionButtons += \`<button onclick="goAfk('\${n}')" class="secondary" style="margin:2px; padding:4px 8px; font-size:11px;">💤</button>\`;
                                }
                                actionButtons += \`<button onclick="collect('\${n}')" class="secondary" style="margin:2px; padding:4px 8px; font-size:11px;">📦</button>\`;
                            }
                            
                            if (info.shards >= 500 && !info.isBuying && !info.isCollecting && info.online) {
                                actionButtons += \`<button onclick="forceBuy('\${n}')" class="success" style="margin:2px; padding:4px 8px; font-size:11px;">💰</button>\`;
                            }
                            
                            actionButtons += \`<button onclick="reconnectBot('\${n}')" class="info" style="margin:2px; padding:4px 8px; font-size:11px;">🔄</button>\`;
                            
                            div.innerHTML += \`
                                <div class="bot-card" style="border-left-color: \${color}">
                                    <div class="bot-info">
                                        <div style="display: flex; align-items: center; gap: 8px;">
                                            <span class="status-dot \${statusColor}"></span>
                                            <b style="color:\${color}; font-size:16px;">\${n}</b>
                                        </div>
                                        <small style="color:#aaa; display: block; margin-top: 4px;">\${info.status}</small>
                                        <div style="display: flex; gap: 10px; margin-top: 4px;">
                                            <small style="color:#555; font-size:10px;">⌛ \${getTimeLeft(info.expires)}</small>
                                            <small style="color:#777; font-size:10px;">🌐 \${info.proxy || 'нет'}</small>
                                            \${info.reconnectAttempts ? '<small style="color:#9c27b0; font-size:10px;">🔄 ' + info.reconnectAttempts + '</small>' : ''}
                                        </div>
                                    </div>
                                    <div class="bot-stats">
                                        <span style="color:\${info.shards >= 500 ? '#4CAF50' : config.theme.accent}; font-weight:bold;">
                                            💎 \${(info.shards || 0).toLocaleString()}\${info.shards >= 500 ? ' ✓' : ''}
                                        </span><br>
                                        <span style="color:#ff9800; font-size:13px;">📦 \${info.spawners || 0} спавнеров</span><br>
                                        <div style="margin-top: 5px;">
                                            \${actionButtons}
                                        </div>
                                    </div>
                                </div>\`;
                        }
                    });
                    
                    // Обновляем статистику сервера
                    fetch('/server-status').then(r => r.json()).then(data => {
                        document.getElementById('server-uptime').innerText = Math.floor(data.uptime);
                        document.getElementById('server-ram').innerText = Math.round(data.memory.heapUsed / 1024 / 1024);
                    });
                }
                
                // Закрытие модального окна по клику вне его
                window.onclick = function(event) {
                    const modal = document.getElementById('settingsModal');
                    if (event.target == modal) {
                        closeSettings();
                    }
                }
                
                setInterval(update, 3000);
                setInterval(updateProxyInfo, 30000);
                setInterval(updateFileInfo, 60000);
                setInterval(updateProgress, 5000);
            </script>
        </body>
        </html>
    `);
});

// Новые API endpoints
app.post('/force-buy-single', (req, res) => {
    const { botName } = req.body;
    const botData = activeBots[botName];
    
    if (botData && botData.botInstance && botData.shards >= 500 && !botData.isBuying) {
        buySpawner(botData.botInstance, botName);
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'Нельзя купить спавнер' });
    }
});

app.post('/force-buy', (req, res) => {
    let count = 0;
    
    for (const [username, botData] of Object.entries(activeBots)) {
        if (botData.online && 
            !botData.error && 
            !botData.isBuying && 
            !botData.isCollecting && 
            botData.shards >= 500 &&
            botData.botInstance) {
            
            setTimeout(() => {
                buySpawner(botData.botInstance, username);
            }, count * 3000);
            
            count++;
        }
    }
    
    res.json({ ok: true, count });
});

app.post('/go-afk', (req, res) => {
    const { botName } = req.body;
    const botData = activeBots[botName];
    
    if (botData && botData.botInstance && botData.online && !botData.isCollecting) {
        goToAfk(botData.botInstance, botName);
        res.json({ ok: true });
    } else {
        res.status(400).json({ error: 'Бот не в сети или занят' });
    }
});

app.post('/afk-all', (req, res) => {
    let count = 0;
    
    for (const [username, botData] of Object.entries(activeBots)) {
        if (botData.online && 
            !botData.error && 
            !botData.isCollecting && 
            !botData.isBuying &&
            botData.botInstance) {
            
            setTimeout(() => {
                goToAfk(botData.botInstance, username);
            }, count * 2000);
            
            count++;
        }
    }
    
    res.json({ ok: true, count });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`Панель управления: http://localhost:${PORT}`);
    console.log(`Загружено прокси: ${getProxies().length}`);
    console.log(`Аккаунтов в файле: ${loadAccountsFromFile().length}`);
    
    // Автоматически продолжаем добавление при перезагрузке
    if (progress.pending > 0 && !progress.isAdding) {
        console.log(`Обнаружены недобавленные аккаунты (${progress.pending} шт.). Можно продолжить через интерфейс.`);
    }
    
    // Запускаем обновление статистики каждые 30 секунд
    setInterval(updateStats, 30000);
});