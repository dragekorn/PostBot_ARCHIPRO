const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
require('dotenv').config();
const express = require('express');
//const stream = require('stream');
//const { promisify } = require('util');
const moment = require('moment');
const schedule = require('node-schedule');
const path = require('path');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const bodyParser = require('body-parser');
const fs = require('fs');
const multer = require('multer');
const config = require('../config.json');
const authKeys = config.authKeys;

const { connectToDB } = require('./services/database');
const { addUser, getAllUsers } = require('./services/userModel');

connectToDB().then(() => {
    console.log('MongoDB connected');
}).catch(err => console.error('Failed to connect to MongoDB', err));

const uploadDir = 'uploads/';
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

const imgDir = 'img/';
fs.mkdirSync(imgDir, { recursive: true });

function sendFileToServer(fileLink, chatId) {
    axios.post('http://localhost:3000/upload', {
        fileLink: fileLink,
        chatId: chatId
    })
    .then((response) => {
        console.log('Файл отправлен на сервер и обработан');
    })
    .catch((error) => {
        console.error('Ошибка при отправке файла на сервер:', error);
    });
}
 
const token = config.token;
const bot = new TelegramBot(token, { polling: true });

bot.on('polling_error', (error) => {
    console.log(error);
});

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const commands = [
    {
        command: "start",
        description: "Команда запуска бота, после которой необходимо аутентифицироваться"
    },
    {
        command: "auth",
        description: "Команда аутентификации в боте. Подготовьте код, выданный вашим менеджером"
    },
    {
        command: "send",
        description: "Команда отправки файла для формирования постов. Это может быть файл XLSX либо CSV. Обязательно настройте файл заранее, чтобы бот корректно составил посты."
    },
    {
        command: "format",
        description: "Команда, которая позволяет настроить единый шаблон для всех постов."
    },
]

bot.setMyCommands(commands).then(() => {
    console.log('Команды установлены успешно');
}).catch(error => {
    console.error('Ошибка при установке команд:', error);
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await addUser(chatId);
    bot.sendMessage(chatId, 'Авторизуйтесь пожалуйста, нажмите на команду /auth');
});

bot.onText(/\/mail (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!authorizedUsers[chatId]) {
        return bot.sendMessage(chatId, 'Вы не авторизованы для этой команды.');
    }

    const text = match[1];
    const users = await getAllUsers();
    users.forEach(user => {
        bot.sendMessage(user.userId, text).catch(error => console.error(`Не удалось отправить сообщение пользователю ${user.userId}:`, error));
    });

    bot.sendMessage(chatId, 'Сообщения отправлены.');
});

let awaitingAuthKey = {};
let authorizedUsers = {};
let awaitingPostFormat = {};
let postFormatTemplate = {};
let pauseInterval = 0;
let targetChatId = null;
let processData = [];
let columnMapping = {};
let selectedColumns = {};
const imageColumnName = "image";

bot.onText(/\/auth/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Пожалуйста, введите ваш ключ авторизации.');
    awaitingAuthKey[chatId] = true;
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;

    // Проверка авторизации
    if (!authorizedUsers[chatId]) {
        if (awaitingAuthKey[chatId]) {
            const authKey = msg.text;
            awaitingAuthKey[chatId] = false;

            if (Array.isArray(authKeys) && authKeys.includes(authKey)) {
                authorizedUsers[chatId] = true;
                bot.sendMessage(chatId, 'Авторизация успешна. Теперь вы можете использовать команду /send.');
            } else {
                bot.sendMessage(chatId, 'Неверный ключ авторизации.');
            }
        }
        return;
    }

    // Проверка ожидания формата поста
    if (awaitingPostFormat[chatId] && msg.text && !msg.text.startsWith('/')) {
        postFormatTemplate[chatId] = msg.text;
        awaitingPostFormat[chatId] = false;
        bot.sendMessage(chatId, 'Формат поста сохранён. Теперь выберите интервал паузы между постами.', {
            reply_markup: {
                keyboard: [['5 сек.', '10 сек.'], ['1 мин.', '5 мин.'], ['1 день', '1 неделя']],
                resize_keyboard: true
            }
        });
        return;
    }

    // Проверка ожидания исключения столбцов
    if (columnMapping[chatId] && msg.text && !msg.text.startsWith('/') && !awaitingPostFormat[chatId]) {
        const excludedColumns = msg.text.split(',').map(Number);
        selectedColumns[chatId] = Object.keys(columnMapping[chatId])
            .filter(key => !excludedColumns.includes(parseInt(key)))
            .map(key => columnMapping[chatId][key]);

        processData = processData.map(row => {
            const filteredRow = {};
            selectedColumns[chatId].forEach(col => {
                filteredRow[col] = row[col];
            });
            return filteredRow;
        });

        saveToJsonFile(chatId, processData);

        // bot.sendMessage(chatId, `Выбранные столбцы:\n${selectedColumns[chatId].join('\n')}\n\nЧтобы продолжить, отправьте /format`);
        return;
    }
});

function saveToJsonFile(chatId, data) {
    const filePath = `uploads/data_${chatId}.json`;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Данные сохранены в файл: ${filePath}`);
}

function formatPost(postData, formatTemplate) {
    let formattedPost = formatTemplate;
    postData.forEach((data, index) => {
        formattedPost = formattedPost.replace(new RegExp(`\\{${index + 1}\\}`, 'g'), data);
    });
    return formattedPost;
}

bot.onText(/\/send/, (msg) => {
    const chatId = msg.chat.id;

    if (authorizedUsers[chatId]) {
        bot.sendMessage(chatId, 'Пожалуйста, отправьте файл в формате CSV, XLSX или SQL.');
    } else {
        bot.sendMessage(chatId, 'Вы не авторизованы. Пожалуйста, используйте команду /auth для авторизации.');
    }
});

bot.on('document', (msg) => {
    const chatId = msg.chat.id;

    if (authorizedUsers[chatId]) {
        const fileId = msg.document.file_id;

        bot.getFileLink(fileId).then((fileLink) => {
           sendFileToServer(fileLink, chatId);
        });
    } else {
        bot.sendMessage(chatId, 'Вы не авторизованы. Пожалуйста, используйте команду /auth для авторизации.');
    }
});

function sendLongMessage(chatId, message) {
    const MAX_LENGTH = 4096;
    for (let i = 0; i < message.length; i += MAX_LENGTH) {
        bot.sendMessage(chatId, message.substring(i, i + MAX_LENGTH));
    }
}

app.post('/upload', async (req, res) => {
    const fileLink = req.body.fileLink;
    const chatId = req.body.chatId;

    try {
        const response = await axios({
            method: 'get',
            url: fileLink,
            responseType: 'stream'
        });

        const fileStream = response.data;

        const fileType = getFileType(fileLink);

        switch (fileType) {
            case 'csv':
                processData = await processCsv(fileStream);
                break;
                case 'xlsx':
                    processData = await processXlsx(fileStream);
                    const columns = processData.length > 0 ? Object.keys(processData[0]) : [];
                    columnMapping[chatId] = columns.reduce((acc, col, index) => {
                        acc[index + 1] = col;
                        return acc;
                    }, {});
                    let message = 'Проанализировав загруженный файл я выявил следующие столбцы с информацией:\n';
                    columns.forEach((col, index) => {
                        message += `${index + 1}. ${col}\n`;
                    });
                    message += '\nПожалуйста, воспользуйтесь шаблонизатором, чтобы оформить единый шаблон постов, который уйдёт на автопостинг.\nИспользуйте команду /format , чтобы продолжить.';
                    sendLongMessage(chatId, message);
                    break;
            default:
                res.status(400).send('Неподдерживаемый формат файла.');
                return;
        }

        console.log('chatId:', chatId);
        res.status(200).send('Файл успешно загружен и обрабатывается');
    } catch (error) {
        console.error('Ошибка при загрузке файла:', error);
        res.status(500).send('Ошибка при обработке файла');
    }
});



function getFileType(fileLink) {
    const extension = path.extname(new URL(fileLink).pathname);

    return extension.slice(1).toLowerCase();
}

async function processXlsx(fileStream) {
    return new Promise((resolve, reject) => {
        let buffers = [];
        fileStream.on('data', (chunk) => buffers.push(chunk));
        fileStream.on('end', () => {
            const buffer = Buffer.concat(buffers);
            const workbook = xlsx.read(buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

            // Обработка каждой строки данных
            const processedData = data.map(row => {
                if (row[imageColumnName] && checkImageExists(row[imageColumnName])) {
                    row.hasImage = true;
                    row.imagePath = path.join(imgDir, row[imageColumnName]);
                } else {
                    row.hasImage = false;
                }
                return row;
            });

            resolve(processedData);
        });
        fileStream.on('error', reject);
    });
}

bot.onText(/\/format/, (msg) => {
    const chatId = msg.chat.id;

    if (!authorizedUsers[chatId]) {
        bot.sendMessage(chatId, 'Вы не авторизованы. Пожалуйста, используйте команду /auth для авторизации.');
        return;
    }

    if (postFormatTemplate[chatId]) {
        bot.sendMessage(chatId, 'Формат поста уже задан. Желаете использовать старый шаблон или сформировать новый?', {
            reply_markup: JSON.stringify({
                inline_keyboard: [
                    [{ text: 'Использовать старый', callback_data: 'use_old' }],
                    [{ text: 'Сформировать новый', callback_data: 'create_new' }]
                ]
            })
        });
    } else {
        awaitingPostFormat[chatId] = true;
        bot.sendMessage(chatId, 'Отправьте мне единый формат постов, как они должны выглядеть, используя HTML-форматирование. Например:\n\n<b>Заголовок</b>\n{1}\n{2}\n{3}\n{4}\nи так далее\n\nВаша подпись');
    }
});

bot.on('callback_query', (callbackQuery) => {
    const action = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    if (action === 'use_old') {
        // Продолжение с использованием старого шаблона
        bot.sendMessage(chatId, 'Выберите интервал паузы между постами.', {
            reply_markup: {
                keyboard: [['5 сек.', '10 сек.'], ['1 мин.', '5 мин.'], ['1 день', '1 неделя']],
                resize_keyboard: true
            }
        });
    } else if (action === 'create_new') {
        // Сброс текущего формата и переход к созданию нового
        postFormatTemplate[chatId] = null;
        awaitingPostFormat[chatId] = true;
        bot.sendMessage(chatId, 'Отправьте мне единый формат постов, как они должны выглядеть.\n\nПример:\n\n**Заголовок**\n1\n2\n3\n4\nи так далее\n\nВаша подпись');
    }
});

function saveGroupToFile(chatId, groupId, groupName) {
    const groupsFilePath = `uploads/groups_${chatId}.json`;
    let groups = {};

    if (fs.existsSync(groupsFilePath)) {
        groups = JSON.parse(fs.readFileSync(groupsFilePath, 'utf8'));
    }

    groups[groupId] = groupName;
    fs.writeFileSync(groupsFilePath, JSON.stringify(groups, null, 2), 'utf8');
}

bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (Object.keys(pauseIntervals).includes(msg.text) && authorizedUsers[chatId]) {
        pauseInterval = pauseIntervals[msg.text];
        const groupsFilePath = `uploads/groups_${chatId}.json`;

        if (fs.existsSync(groupsFilePath)) {
            const groups = JSON.parse(fs.readFileSync(groupsFilePath, 'utf8'));
            let groupsList = 'У Вас уже были сессии автопостинга в следующие группы/каналы:\n';
            Object.keys(groups).forEach((groupId) => {
                groupsList += `<b>${groups[groupId]}</b> | ID: <code>${groupId}</code>\n`;
            });
            groupsList += '\nЖелаете добавить новый канал/группу или впишите ID уже существующей в нашей базе.';

            bot.sendMessage(chatId, groupsList, {
                parse_mode: 'HTML',
                reply_markup: JSON.stringify({
                    inline_keyboard: [
                        [{ text: 'Добавить новый канал/группу', callback_data: 'new_channel' }]
                    ]
                })
            });
        } else {
            bot.sendMessage(chatId, 
                "Если у Вас есть ID телеграм канала/группы, отправьте его мне, добавьте меня туда админом и разрешите управлять сообщениями.\n" +
                "Если у Вас есть ссылка на телеграм канал/группу, отправьте её мне, я Вам пришлю в ответе ID, после чего добавьте меня туда админом и разрешите управлять сообщениями."
            );
        }
    } else if (!isNaN(msg.text) && authorizedUsers[chatId] && pauseInterval) {
        targetChatId = msg.text;
    
        bot.getChat(targetChatId).then(chat => {
            const groupName = chat.title || `Группа/Канал ${targetChatId}`;
            saveGroupToFile(chatId, targetChatId, groupName);

            if (isAutoPostingPaused) {
                isAutoPostingPaused = false;
                sendNextPost(chatId);
            } else {
                startAutoPost(chatId, false);
            }
        }).catch(error => {
            console.error('Ошибка при получении данных о группе/канале:', error);
            bot.sendMessage(chatId, 'Не удалось получить информацию о группе/канале. Пожалуйста, проверьте правильность ID и убедитесь, что бот является участником группы/канала.');
        });
    }
});



let isAutoPostingPaused = false;
let isAutoPostingCancelled = false; 
let currentAutoPostIndex = 0; // Текущий индекс автопостинга
let jsonData = []; // Массив постов
let progressMessageId; // ID сообщения о прогрессе

function updateAutoPostProgress(chatId, index, total) {
    const progressText = `‼️Автопостинг запущен в канал/группу: ${targetChatId}\n♻️ Осталось постов: ${total}`;
    const opts = {
        chat_id: chatId,
        message_id: progressMessageId,
        reply_markup: JSON.stringify({
            inline_keyboard: [
                [{ text: 'Приостановить', callback_data: 'pause' }],
                [{ text: 'Отменить', callback_data: 'cancel' }]
            ]
        })
    };
    bot.editMessageText(progressText, opts);
}

function startAutoPost(chatId, reloadJson = true) {
    const jsonDataPath = `uploads/data_${chatId}.json`;
    if (fs.existsSync(jsonDataPath)) {
        if (reloadJson || !jsonData || jsonData.length === 0) {
            jsonData = JSON.parse(fs.readFileSync(jsonDataPath, 'utf8'));
        }
        currentAutoPostIndex = 0;
        isAutoPostingCancelled = false;

        bot.sendMessage(chatId, 'Начинаем автопостинг...').then(sentMessage => {
            progressMessageId = sentMessage.message_id;
            sendNextPost(chatId);
        });
    } else {
        bot.sendMessage(chatId, 'Не удалось найти файл данных для автопостинга.');
    }
}

function checkImageExists(imageName) {
    const filePath = path.join(imgDir, imageName);
    return fs.existsSync(filePath) && /\.(jpg|jpeg|png)$/i.test(filePath);
}

function sendNextPost(chatId) {
    if (currentAutoPostIndex < jsonData.length && !isAutoPostingPaused && !isAutoPostingCancelled) {
        const postData = jsonData[currentAutoPostIndex];
        const postText = formatPost(Object.values(postData), postFormatTemplate[chatId]);

        const options = { parse_mode: 'HTML' };

        const sendPost = async () => {
            try {
                if (postData.hasImage) {
                    const photoStream = fs.createReadStream(postData.imagePath);
                    await bot.sendPhoto(targetChatId, photoStream, { ...options, caption: postText });
                } else {
                    await bot.sendMessage(targetChatId, postText, options);
                }
                // Успешная отправка поста
                currentAutoPostIndex++;
                updateAutoPostProgress(chatId, currentAutoPostIndex, jsonData.length - currentAutoPostIndex);
                // Проверяем, остались ли еще посты
                if (currentAutoPostIndex < jsonData.length) {
                    setTimeout(() => sendNextPost(chatId), pauseInterval);
                } else {
                    // Все посты отправлены
                    console.log('Автопостинг завершен');
                    bot.sendMessage(chatId, 'Автопостинг завершен. Все посты отправлены.');
                    jsonData = [];
                    fs.unlinkSync(`uploads/data_${chatId}.json`);
                }
            } catch (error) {
                console.error('Ошибка при отправке сообщения или изображения:', error);
                setTimeout(() => sendNextPost(chatId), pauseInterval);
            }
        };

        sendPost();
    } else if (!isAutoPostingPaused && !isAutoPostingCancelled && jsonData.length === 0) {
        bot.sendMessage(chatId, 'Автопостинг завершен. Все посты отправлены.');
    }
}

bot.on('callback_query', (callbackQuery) => {
    const action = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;

    if (action === 'same_channel') {
        startAutoPost(chatId, false);
    } else if (action === 'new_channel') {
        bot.sendMessage(chatId, 'Введите ID нового телеграм канала/группы, где необходимо разместить посты');
    }

    if (action === 'pause') {
        isAutoPostingPaused = !isAutoPostingPaused;
        const statusText = isAutoPostingPaused ? 'Автопостинг приостановлен.' : 'Автопостинг возобновлен.';
        bot.answerCallbackQuery(callbackQuery.id, { text: statusText });

        const newButtonText = isAutoPostingPaused ? 'Продолжить' : 'Приостановить';
        const opts = {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id,
            reply_markup: JSON.stringify({
                inline_keyboard: [
                    [{ text: newButtonText, callback_data: 'pause' }],
                    [{ text: 'Отменить', callback_data: 'cancel' }],
                    [{ text: 'Изменить шаблон рассылки', callback_data: 'change_template' }]
                ]
            })
        };
        bot.editMessageReplyMarkup(opts.reply_markup, opts);

        if (!isAutoPostingPaused) {
            sendNextPost(chatId);
        }
    } else if (action === 'cancel') {
        isAutoPostingPaused = false;
        isAutoPostingCancelled = true;
        currentAutoPostIndex = 0;
        jsonData = []; 
        postFormatTemplate[chatId] = null;

        const jsonDataPath = `uploads/data_${chatId}.json`;
        if (fs.existsSync(jsonDataPath)) {
            fs.unlinkSync(jsonDataPath);
        }
        bot.sendMessage(chatId, 'Автопостинг отменен. Файл с постами удален.\nЧтобы начать новый сеанс отправьте новый файл и настройте заново автопостинг /send');
        bot.answerCallbackQuery(callbackQuery.id);
    } else if (action === 'change_template') {
        postFormatTemplate[chatId] = null;
        awaitingPostFormat[chatId] = true;
        bot.sendMessage(chatId, 'Отправьте мне новый формат постов.');
    }
});

const pauseIntervals = {
    '5 сек.': 5000,
    '10 сек.': 10000,
    '1 мин.': 60000,
    '5 мин.': 300000,
    '1 день': 86400000,
    '1 неделя': 604800000
};

const port = 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});