var VALID_VOLUME_NAME_REGEXP = /^[a-zA-Z0-9][a-zA-Z0-9_\.\-]+$/;

function validateVolumeName(name) {
    var validName = typeof(name) === 'string' &&
        name !== '' &&
        name.match(VALID_VOLUME_NAME_REGEXP);
     var err;

     if (!validName) {
         err = new Error(name + ' is not a valid volume name');
     }

     return err;
}

function validateVolumeType(type) {
    var err;

    if (type !== 'tritonnfs') {
        err = new Error('Volume type: ' + type + ' is not supported');
    }

    return err;
}

module.exports = {
    validateVolumeName: validateVolumeName,
    validateVolumeType: validateVolumeType
};