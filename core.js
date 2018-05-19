'use strict'

const log = require('fancy-log'),
      jsdom = require('jsdom'),
      { JSDOM } = jsdom

// Defines playback data fetched from MPC.
let playback = {
    filename: '',
    position: '',
    duration: '',
    fileSize: '',
    state: '',
    prevState: '',
    prevPosition: '',
}

// Defines strings and image keys according to the 'state' string
// provided by MPC.
const states = {
    '-1': {
        string: 'Idling',
        stateKey: 'stop_small'
    },
    '0': {
        string: 'Stopped',
        stateKey: 'stop_small'
    },
    '1': {
        string: 'Paused',
        stateKey: 'pause_small'
    },
    '2': {
        string: 'Playing',
        stateKey: 'play_small'
    }
}

/**
 * Sends Rich Presence updates to Discord client.
 * @param {SnekfetchResponse} res Response from MPC Web Interface variables page
 * @param {RPCClient} rpc Discord Client RPC connection instance
 */
const updatePresence = (res, rpc) => {
    // Gets a DOM object based on MPC Web Interface variables page.
    let { document } = new JSDOM(res.body).window

    // Gets relevant info from the DOM object.
    playback.filename = document.getElementById('filepath').textContent.split("\\").pop()
    playback.state = document.getElementById('state').textContent
    playback.duration = sanitizeTime(document.getElementById('durationstring').textContent)
    playback.position = sanitizeTime(document.getElementById('positionstring').textContent)

    // Prepares playback data for Discord Rich Presence.
    let payload = {
        state: playback.duration + ' total',
        startTimestamp: undefined,
        details: playback.filename,
        largeImageKey: 'default',
        smallImageKey: states[playback.state].stateKey,
        smallImageText: states[playback.state].string
    }

    // Makes changes to payload data according to playback state.
    switch (playback.state) {
        case '-1': // Idling
            payload.state = states[playback.state].string
            payload.details = undefined
            break;
        case '1': // Paused
            payload.state = playback.position + ' / ' + playback.duration
            break;
        case '2': // Playing
            payload.startTimestamp = (Date.now() / 1000) - convert(playback.position)
            break;
    }

    // Only sends presence updates if playback state changes or if playback position
    // changes while playing.
    if ((playback.state !== playback.prevState) || (
        playback.state === '2' &&
        convert(playback.position) !== convert(playback.prevPosition) + 5
    )) {
        rpc.setActivity(payload)
        log.info('INFO: Presence update sent: ' +
            `${states[playback.state].string} - ${playback.position} / ${playback.duration} - ${playback.filename}`
        )
    }

    // Replaces previous playback state and position for later comparison.
    playback.prevState = playback.state
    playback.prevPosition = playback.position
    return true
}

/**
 * Simple and quick utility to convert time from 'hh:mm:ss' format to seconds.
 * @param {string} time Time string formatted as 'hh:mm:ss'
 * @returns {number} Number of seconds converted from the given time string
 */
const convert = time => {
    let parts = time.split(':'),
        seconds = parseInt(parts[parts.length - 1]),
        minutes = parseInt(parts[parts.length - 2]),
        hours = (parts.length > 2) ? parseInt(parts[0]) : 0
    return ((hours * 60 * 60) + (minutes * 60) + seconds)
}

/**
 * In case the given 'hh:mm:ss' formatted time string time is less than 1 hour,
 * removes the '00' hours from it.
 * @param {string} time Time string formatted as 'hh:mm:ss'
 * @returns {string} Time string without '00' hours
 */
const sanitizeTime = time => {
    if (time.split(':')[0] === '00') {
        return time.substr(3, time.length - 1)
    }
    return time
}

module.exports = updatePresence
