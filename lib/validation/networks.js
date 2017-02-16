/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

var UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function validateNetwork(networkUuid) {
    var validNetwork = typeof (networkUuid) === 'string'&&
        UUID_RE.test(networkUuid);
    var err;

    if (!validNetwork) {
        err = new Error(networkUuid + ' is not a valid network UUID');
    }

    return err;
}

module.exports = {
    validateNetwork: validateNetwork
};