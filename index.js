const log = require('fancy-log');

log.info('INFO: Loading...');



[`SIGINT`, `SIGUSR1`, `SIGUSR2`, `SIGTERM`].forEach(eventType => {
	process.on(eventType, shutdown);
});

const axios = require('axios').default,
	FormData = require('form-data'),
	{ Client } = require('@xhayper/discord-rpc'),
	updatePresence = require('./core'),
	events = require('events'),
	sharp = require('sharp'),
	config = require('./config'),
	http = require('http'),
	fs = require('fs'),
	path = require('path'),
	ngrok = require('ngrok'),
	
	// clientId = '427863248734388224';
	clientId = '1108520115466678332';

let mediaEmitter = new events.EventEmitter(),
	active = false,
	discordRPCLoop,
	mpcServerLoop,
	snapshotLoop,
	snapshot,
	rpc,
	ngrokUrl;

// Checks if port set in config.js is valid.
if (isNaN(config.port)) {
	throw new Error("Port is empty or invalid! Please set a valid port number in 'config.js' file.");
}

const uri = `http://127.0.0.1:${config.port}/variables.html`;

// Crear servidor HTTP local para servir las imágenes
const localServer = http.createServer(async (req, res) => {
  // Validación básica: rechazar peticiones muy largas
  if (!req.url || req.url.length > 500) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid request');
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/thumbnail.jpg') {
      const thumbnailPath = path.join(__dirname, 'thumbnail.jpg');
      try {
        const fileBuffer = await fs.promises.readFile(thumbnailPath);

        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': fileBuffer.length,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        res.end(fileBuffer);
      } catch (err) {
        if (err.code === 'ENOENT') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Thumbnail not found');
        } else {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error reading thumbnail');
        }
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  } catch (err) {
    // Validación de URL inválida
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid request');
  }
});

// Iniciar servidor local y ngrok
localServer.listen(8080, '127.0.0.1', async () => {
  log.info('Local image server started on http://127.0.0.1:8080');
  try {
    ngrokUrl = await ngrok.connect(8080);
    log.info(`Ngrok tunnel created: ${ngrokUrl}`);
  } catch (err) {
    log.error('Failed to create ngrok tunnel:', err.message);
  }
});

log.info('INFO: Fully ready. Trying to connect to Discord client...');

// When it succesfully connects to MPC Web Interface, it begins checking MPC
// every 5 seconds, getting its playback data and sending it to Discord Rich Presence
// through updatePresence() function from core.js.
mediaEmitter.on('CONNECTED', res => {
	clearInterval(mpcServerLoop);
	mpcServerLoop = setInterval(checkMPCEndpoint, 5000);
	
	// Procesar snapshots siempre (Imgur primero, ngrok como fallback)
	clearInterval(snapshotLoop);
	uploadSnapshot();
	snapshotLoop = setInterval(uploadSnapshot, 120_000);
	
	let forceUpdate = false;
	if (!active) {
		log.info(`INFO: Connected to ${res.headers.server}`);
		forceUpdate = true;
	}
	active = updatePresence({ ...res, snapshot }, rpc, forceUpdate);
});

// When connection to MPC fails it attempts to connect
// to MPC again every 15 seconds.
mediaEmitter.on('CONN_ERROR', code => {
	log.error(
		`ERROR: Unable to connect to Media Player Classic on port ${config.port}. ` +
			`Make sure MPC is running, Web Interface is enabled and the port set in 'config.js' file is correct.\n` +
			code
	);
	// If MPC was previously connected (ie. MPC gets closed while script is running)
	// the whole process is killed and restarted by Forever in order to clean MPC Rich Presence
	// from user's profile, as destroyRPC() apparently can't do so.
	if (active) {
		destroyRPC().catch(err => log.error('Failed to destroy RPC', err));
		// log.warn('WARN: Killing process to clean Rich Presence from your profile...');
		// process.exit(0);
	}
	clearInterval(snapshotLoop);
	if (!mpcServerLoop || mpcServerLoop._onTimeout !== checkMPCEndpoint) {
		clearInterval(mpcServerLoop);
		mpcServerLoop = setInterval(checkMPCEndpoint, 15000);
	}
});

// If RPC successfully connects to Discord client,
// it will attempt to connect to MPC Web Interface every 15 seconds.
mediaEmitter.on('discordConnected', () => {
	clearInterval(discordRPCLoop);
	log.info('INFO: Connected to Discord. Listening MPC on ' + uri);
	checkMPCEndpoint();
	mpcServerLoop = setInterval(checkMPCEndpoint, 15000);
});

// If RPC gets disconnected from Discord Client,
// it will stop checking MPC playback data.
mediaEmitter.on('discordDisconnected', () => {
	clearInterval(mpcServerLoop);
	clearInterval(snapshotLoop);
	active = false;
});

// Tries to connect to MPC Web Interface and,
// if connected, fetches its data.
function checkMPCEndpoint() {
	axios
		.get(uri)
		.then(res => {
			mediaEmitter.emit('CONNECTED', res);
		})
		.catch(err => {
			mediaEmitter.emit('CONN_ERROR', err);
		});
}




async function uploadSnapshot() {
  log.info('INFO: Processing snapshot locally...');
  try {
    // 1. Descargamos el snapshot original
    const { data: image } = await axios.get(
      `http://127.0.0.1:${config.port}/snapshot.jpg`, {
        responseType: 'arraybuffer',
        validateStatus: status => status === 200
      }
    );

    // 2. Generamos la miniatura con Sharp
    const thumbnail = await sharp(image)
      .resize({ width: 512, height: 512, fit: 'cover', withoutEnlargement: true })
      .jpeg()
      .toBuffer();
    log.info(`Thumbnail size ${(thumbnail.length / 1024).toFixed(1)} kB`);

    // 3. Guardamos la imagen localmente
    const thumbnailPath = path.join(__dirname, 'thumbnail.jpg');
    fs.writeFileSync(thumbnailPath, thumbnail);

    const oldSnapshot = snapshot;

    // 4. Intentar subir a Imgur como servicio principal
    try {
      const form = new FormData();
      form.append('image', thumbnail.toString('base64'));
      
      const imgurResponse = await axios.post('https://api.imgur.com/3/image', form, {
        headers: {
          ...form.getHeaders(),
          'Authorization': 'Client-ID 546c25a59c58ad7',
        },
        timeout: 10000, // 10 seconds timeout
      });

      if (imgurResponse.data && imgurResponse.data.data && imgurResponse.data.data.link) {
        snapshot = imgurResponse.data.data.link;
        log.info(`INFO: Snapshot uploaded to Imgur: ${snapshot}`);
      } else {
        throw new Error('Invalid Imgur response');
      }
    } catch (imgurError) {
      log.warn('WARN: Imgur upload failed, trying ngrok fallback:', imgurError.message);
      
      // Fallback a ngrok si Imgur falla
      if (ngrokUrl) {
        const timestamp = Date.now();
        snapshot = `${ngrokUrl}/thumbnail.jpg?t=${timestamp}`;
        log.info(`INFO: Using ngrok fallback: ${snapshot}`);
      } else {
        log.error('ERROR: Both Imgur and ngrok unavailable, using placeholder');
        snapshot = 'https://via.placeholder.com/512x512.jpg?text=Thumbnail+Error';
      }
    }

    // 5. Forzar actualización del Rich Presence si cambió la imagen
    if (oldSnapshot !== snapshot && rpc && active) {
      log.info('INFO: Forcing Rich Presence update with new thumbnail');
      // Forzar una actualización inmediata
      checkMPCEndpoint();
    }

  } catch (err) {
    log.error('ERROR processing snapshot locally:', err.message);
  }
}


    



// Initiates a new RPC connection to Discord client.
function initRPC(clientId) {
	try {
		rpc = new Client({ clientId, transport: { type: 'ipc' } });
		rpc.on('ready', () => {
			clearInterval(discordRPCLoop);
			mediaEmitter.emit('discordConnected');
			rpc.transport.on('error', err => log.error('RPC error', err));
			rpc.transport.once('close', async () => {
				await destroyRPC();
				log.error('ERROR: Connection to Discord client was closed. Trying again in 10 seconds...');
				mediaEmitter.emit('discordDisconnected');
				discordRPCLoop = setInterval(initRPC, 10000, clientId);
			});
		});

		// Log in to the RPC server on Discord client, and check whether or not it errors.
		rpc.login({ clientId }).catch(async err => {
			log.error('Error on RPC login', err);
			log.warn('WARN: Connection to Discord has failed. Trying again in 10 seconds...');
		});
	} catch (err) {
		log.error('Error on initRPC', err);
		log.warn('WARN: Connection to Discord has failed. Trying again in 10 seconds...');
	}
}

// Destroys any active RPC connection.
async function destroyRPC() {
	if (!rpc) return;
	await rpc.destroy();
	rpc = null;
}

// Boots the whole script, attempting to connect
// to Discord client every 10 seconds.
discordRPCLoop = setInterval(() => initRPC(clientId), 10000);
initRPC(clientId);

async function shutdown() {
	log.info('Shutting down...');
	try {
		await destroyRPC();
		localServer.close();
		await ngrok.kill();
		log.info('Local server and ngrok tunnel closed');
	} catch (err) {
		log.error('Error on shutdown', err);
	} finally {
		process.exit();
	}
}
