/* main.js
 *
 * Copyright 2024 Justin Donnelly
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio'; // Required by GJS, version not necessary.
import GLib from 'gi://GLib'; // Required by GJS, version not necessary.
import GLibUnix from 'gi://GLibUnix?version=2.0';
import GObject from 'gi://GObject'; // Required by GJS, version not necessary.

import { ChooseZoneWindow } from './chooseZoneWindow.js';
import { ConnectionIdsSeen } from './connectionIdsSeen.js';
import { DependencyCheck } from './dependencyCheck.js';
import { NetworkState } from './networkState.js';
import { ZoneForConnection } from './zoneForConnection.js';
import { ZoneInfo } from './zoneInfo.js';

import promisify from './promisify.js';

pkg.initGettext();
// The line below was generated by GNOME Builder with the template. But eslint doesn't seem to like it. For now, we'll
// ignore it.
// eslint-disable-next-line no-restricted-properties
pkg.initFormat();

export const ZoneDefenseApplication = GObject.registerClass(
    class ZoneDefenseApplication extends Adw.Application {
        #sourceIds = [];
        #connectionIdsSeen;
        #networkStateErrorHandlerId;
        #networkStateConnectionChangedHandlerId;
        #quitting = false;

        constructor() {
            super({
                application_id: 'com.github.justinrdonnelly.ZoneDefense',
                flags: Gio.ApplicationFlags.DEFAULT_FLAGS,
            });

            console.log('Welcome to Zone Defense! Starting up.');
            promisify();
            this.#connectionIdsSeen = new ConnectionIdsSeen();

            // about action
            this._showAboutAction = new Gio.SimpleAction({ name: 'about' });
            // eslint-disable-next-line no-unused-vars
            this._showAboutActionHandlerId = this._showAboutAction.connect('activate', (action) => {
                let aboutParams = {
                    application_name: 'zone-defense',
                    application_icon: 'com.github.justinrdonnelly.ZoneDefense',
                    developer_name: 'Justin Donnelly',
                    version: '47.0.0',
                    developers: ['Justin Donnelly'],
                    copyright: '© 2024 Justin Donnelly',
                };
                const aboutDialog = new Adw.AboutDialog(aboutParams);
                aboutDialog.present(this.active_window);
            });
            this.add_action(this._showAboutAction);

            // handle signals
            const signals = [2, 15];
            signals.forEach((signal) => {
                const gsourceSignal = GLibUnix.signal_source_new(signal);
                gsourceSignal.set_callback(() => {
                    this.quit(signal);
                });
                this.#sourceIds.push(gsourceSignal.attach(null));
            });

            // fire and forget
            this.init()
              .catch(e => {
                console.error('Unhandled error in main init. This is a bug!');
                console.error(e);
              });
        } // end constructor

        // The init method will instantiate NetworkState and listen for its signals. We do this outside the constructor
        // so we can be async.
        async init() {
            let dependencyCheck = null;
            let handlerId = null;
            try {
                dependencyCheck = new DependencyCheck();
                handlerId = dependencyCheck.connect('error', this.#handleErrorSignal.bind(this));
                await dependencyCheck.runChecks();
            } catch (e) {
                // This should really never happen. DependencyCheck is full of `try/catch`es, so exceptions shouldn't
                // get this far. Since we don't know how this happened, we'll log it, continue, and hope for the best.
                console.error('Error in dependency check.');
                console.error(e.message);
                const notification = new Gio.Notification();
                notification.set_title('Unknown error');
                notification.set_body('An unknown error occurred. Zone Defense may not function correctly. Please ' +
                    'see logs for more information.');
                this.send_notification('main-dependency-unknown-error', notification);
            } finally {
                dependencyCheck.disconnect(handlerId);
            }
            try {
                await this.#connectionIdsSeen.init();
            } catch (e) {
                // Bail out here... There's nothing we can reasonably do without knowing if a network has been seen.
                console.error('Unable to initialize ConnectionIdsSeen.');
                console.error(e.message);
                const notification = new Gio.Notification();
                notification.set_title('Can\'t find previously seen connections');
                notification.set_body('There was a problem determining which connections have already been seen. ' +
                    'Please see logs for more information.'
                );
                this.send_notification('main-connection-ids', notification);
                this.quit(null);
            }

            // Create the `connectionChangedAction` action. We'll pass it to NetworkState.
            try {
                this._connectionChangedAction = new Gio.SimpleAction({
                    name: 'connectionChangedAction',
                    parameter_type: new GLib.VariantType('as'),
                });

                this._connectionChangedActionHandlerId =
                    this._connectionChangedAction.connect('activate', async (action, parameter) => {
                    try {
                        const parameters = parameter.deepUnpack();
                        console.log(`${action.name} parameters: ${parameters}`);
                        const connectionId = parameters[0];
                        const activeConnectionSettings = parameters[1];
                        this.closeWindowIfConnectionChanged(connectionId);
                        // bail out if there is no connection
                        if (connectionId === '')
                            return;

                        const isConnectionNew = this.#connectionIdsSeen.isConnectionNew(connectionId);
                        if (!isConnectionNew)
                            // The connection is not new. Don't open the window.
                            return;

                        const [zones, defaultZone, currentZone] = await Promise.all([
                            ZoneInfo.getZones(),
                            ZoneInfo.getDefaultZone(),
                            ZoneForConnection.getZone(activeConnectionSettings),
                        ]);
                        this.createWindow(connectionId, defaultZone, currentZone, zones, activeConnectionSettings);
                    } catch (e) {
                        // We've hit an exception in the callback where we'd consider opening the window. Bail out and
                        // hope for better luck next time (unlikely).
                        console.error('Error while trying to prompt. This is likely related to getting zone ' +
                            'information.');
                        console.error(e.message);
                        const notification = new Gio.Notification();
                        notification.set_title('Can\'t prompt for firewall zone.');
                        notification.set_body('There was a problem getting information to prompt for the firewall ' +
                            'zone. Please see logs for more information.');
                        this.send_notification('main-network-state-activate', notification);
                    }
                });

                this.networkState = new NetworkState(this._connectionChangedAction);
                this.#networkStateErrorHandlerId = this.networkState.connect(
                    'error', this.#handleErrorSignal.bind(this));
                this.#networkStateConnectionChangedHandlerId = this.networkState.connect(
                    'connection-changed', this.#handleConnectionChangedSignal.bind(this));
            } catch (e) {
                // Bail out here... There's nothing we can do without NetworkState.
                console.error('Unable to initialize NetworkState.');
                console.error(e.message);
                const notification = new Gio.Notification();
                notification.set_title('Can\'t determine network state.');
                notification.set_body('There was a problem tracking network connection changes. Please see logs for ' +
                    'more information.');
                this.send_notification('main-network-state', notification);
                this.quit(null);
            }
        } // end init

        vfunc_activate() {} // Required because Adw.Application extends GApplication.

        #handleErrorSignal(emittingObject, fatal, id, title, message) {
            if (fatal)
                message += ' Zone Defense is shutting down. You will need to restart manually.';
            const notification = new Gio.Notification();
            notification.set_title(title);
            notification.set_body(message);
            this.send_notification(id, notification);
            if (fatal) {
                this.quit(null);
            }
        }

        async #handleConnectionChangedSignal(emittingObject, connectionId, activeConnectionSettings) {
            try {
                this.closeWindowIfConnectionChanged(connectionId);
                // bail out if there is no connection
                if (connectionId === '')
                    return;

                const isConnectionNew = this.#connectionIdsSeen.isConnectionNew(connectionId);
                if (!isConnectionNew)
                    // The connection is not new. Don't open the window.
                    return;

                const [zones, defaultZone, currentZone] = await Promise.all([
                    ZoneInfo.getZones(),
                    ZoneInfo.getDefaultZone(),
                    ZoneForConnection.getZone(activeConnectionSettings),
                ]);
                this.createWindow(connectionId, defaultZone, currentZone, zones, activeConnectionSettings);
            } catch (e) {
                // We've hit an exception in the callback where we'd consider opening the window. Bail out and
                // hope for better luck next time (unlikely).
                console.error('Error while trying to prompt. This is likely related to getting zone ' +
                    'information.');
                console.error(e.message);
                const notification = new Gio.Notification();
                notification.set_title('Can\'t prompt for firewall zone.');
                notification.set_body('There was a problem getting information to prompt for the firewall ' +
                    'zone. Please see logs for more information.');
                this.send_notification('main-network-state-activate', notification);
            }
        }

        createWindow(connectionId, defaultZone, currentZone, zones, activeConnectionSettings) {
            let { active_window } = this;

            // active_window should always be null. Either this is the first creation, or we should have already called
            // closeWindowIfConnectionChanged.
            if (!active_window)
                active_window = new ChooseZoneWindow(
                    this,
                    connectionId,
                    defaultZone,
                    currentZone,
                    zones,
                    activeConnectionSettings
                );

            active_window.present();
        }

        closeWindowIfConnectionChanged(connectionId) {
            let { active_window } = this;
            if (active_window?.connectionId !== connectionId)
                active_window?.close();
        }

        async chooseClicked(connectionId, activeConnectionSettings, zone, defaultZone) {
            console.log(`For connection ID ${connectionId}, setting zone to ` +
                `${zone ?? ChooseZoneWindow.defaultZoneLabel}`);
            // Update seen connections before updating the zone. If the connection ID hasn't been added to the list of
            // seen connections when the zone is changed, the window will open again!
            // Don't try/catch here. We'll let the exception propagate.
            this.#connectionIdsSeen.addConnectionIdToSeen(connectionId);
            await ZoneForConnection.setZone(activeConnectionSettings, zone);

            const notification = new Gio.Notification();
            notification.set_title(`Firewall zone set for ${connectionId}`);
            if (zone === null) // this is the default zone
                notification.set_body(`Firewall zone for ${connectionId} has been set to the default zone (currently ` +
                    `${defaultZone}). Whenever you connect to ${connectionId} in the future, the firewall zone will ` +
                    'automatically be changed to the default zone.'
                );
            else
                notification.set_body(`Firewall zone for ${connectionId} has been set to ${zone}. Whenever you ` +
                    `connect to ${connectionId} in the future, the firewall zone will automatically be changed to ` +
                    `${zone}.`
                );
            this.send_notification('main-zone-chosen', notification);
        }

        quit(signal) {
            if (this.#quitting) {
                console.log('Skipping duplicate attempt to quit');
                return; // We are already quitting. Trying again will cause problems.
            }
            this.#quitting = true;
            if (signal === null)
                console.log('quitting with no signal!');
            else
                console.log(`quitting due to signal ${signal}!`);
            this.#sourceIds?.forEach((id) => GLib.Source.remove(id));
            this.networkState?.disconnect(this.#networkStateErrorHandlerId);
            this.networkState?.disconnect(this.#networkStateConnectionChangedHandlerId);
            this.networkState?.destroy();
            this.networkState = null;
            this._showAboutAction?.disconnect(this._showAboutActionHandlerId);
            this._connectionChangedAction?.disconnect(this._connectionChangedActionHandlerId);
            super.quit(); // this ends up calling vfunc_shutdown()
        }
    }
);

export function main(argv) {
    const application = new ZoneDefenseApplication();
    application.hold();
    return application.runAsync(argv);
}
