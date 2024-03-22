const { app, Tray, Menu } = require('electron');
const log = require('fancy-log');
const { name, version } = require('./package.json');

/**
 * Prevent electron from running multiple instances.
 */
const isSingleInstance = app.requestSingleInstanceLock();
if (!isSingleInstance) {
	app.quit();
	process.exit(0);
}

(async function () {
	try {
		await app.whenReady();
		const tray = new Tray('./build/icon.png');
		const contextMenu = Menu.buildFromTemplate([{ label: `${name} ${version}`, enabled: false }, { type: 'separator' }, { role: 'quit' }]);
		tray.setToolTip('MPC-Discord is running');
		tray.setContextMenu(contextMenu);
		require('./index.js');
	} catch (err) {
		log.error('ERROR: Error on application start', err);
	}
})();
