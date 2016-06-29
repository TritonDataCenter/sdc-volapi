/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

var assert = require('assert-plus');
var util = require('util');

/*
 * Checks that the volume object "volume"'s properties meet some basic
 * requirements.
 */
function checkVolumeObjectFormat(volume, values, test) {
    assert.object(volume, 'volume');
    assert.object(values, 'values');
    assert.object(test, 'test');

    test.equal(volume.type, values.type,
        util.format('newly created volume\'s type should be "%s"',
            values.type));
    test.equal(volume.name, values.name,
        util.format('newly created volume\'s name should be "%s"',
            values.name));
    test.ok(volume.uuid, 'newly created volume should have a UUID');
    test.ok(volume.vm_uuid, 'newly created volume should have a VM UUID');
    test.ok(new Date(volume.create_timestamp),
        'newly created volume should have a valid timestamp');
    test.ok(volume.filesystem_path,
        'newly created volume should have a filesystem_path');
    test.ok(volume.owner_uuid, 'newly created volume should have a owner UUID');
    test.ok(volume.requested_size === undefined ||
        typeof (volume.requested_size) === 'number',
            'newly created volume has an optional requested size');
    test.ok(volume.size, 'newly created volume should have a size');
}

module.exports = {
    checkVolumeObjectFormat: checkVolumeObjectFormat
};