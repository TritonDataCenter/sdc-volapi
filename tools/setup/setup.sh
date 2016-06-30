#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2016, Joyent, Inc.
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: '\
        '${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail

TOP=$(cd $(dirname $0)/../../; pwd)

function fatal
{
    echo "$0: fatal error: $*"
    exit 1
}

function errexit
{
    [[ $1 -ne 0 ]] || exit 0
    fatal "error exit status $1"
}

function usage
{
    echo "Usage:"
    echo "setup [ssh-datacenter-name]"
    echo ""
    echo "ssh-datacenter-name is a name that can be used to connect via ssh"
    echo "to the datacenter on which to setup VOLAPI. It defaults to \"coal\"."
    exit 1
}

trap 'errexit $?' EXIT

if [ "$#" -gt 1 ]; then
    usage
fi

datacenter_name="coal"
if [ "x$1" != "x" ]; then
    datacenter_name="$1"
fi

echo "Setting up VOLAPI in $datacenter_name..."

ssh root@"$datacenter_name" /bin/bash -l << "EOS"
if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: '\
        '${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi

set -o errexit
set -o pipefail

function fatal
{
    echo "$0: fatal error: $*"
    exit 1
}

function get_latest_img_uuid
{
    local image_name=$1
    local branch_pattern=$2
    local images
    local latest_img

    images=$(/opt/smartdc/bin/updates-imgadm -H -C experimental \
        list name=$image_name | cut -d ' ' -f 1)
    # Find latest image with a name that matches $image_name created from a
    # branch whose name matches $branch_pattern. It is currently assumed that
    # the output of updates-imgadm list is sorted by publishing date.
    for IMG in ${images};\
    do
        latest_img=$(updates-imgadm -C experimental get "${IMG}" | \
            json -c "version.indexOf('"${branch_pattern}"') !== -1 || \
            (tags != null && tags.buildstamp != null && \
            tags.buildstamp.indexOf('"${branch_pattern}"') !== -1)" uuid)
    done

    echo "$latest_img"
}

function get_service_installed_img_uuid
{
    local service_name=$1
    local installed_img_uuid

    installed_img_uuid=$(sdc-sapi /services?name="$service_name" | \
        json -Ha params.image_uuid)

    echo "$installed_img_uuid"
}

function upgrade_core_service_to_latest_branch_image
{
    local core_service_name=$1
    local branch_name=$2

    local installed_img_uuid
    local latest_img_uuid

    echo "Making sure $core_service_name core zone is up to date..."

    installed_img_uuid=$(get_service_installed_img_uuid "$core_service_name")
    echo "Current installed $core_service_name image:"\
        "$installed_img_uuid"

    latest_img_uuid=$(get_latest_img_uuid "$core_service_name" "$branch_name")
    if [ "x$latest_img_uuid" != "x" ]; then
        if [ "$latest_img_uuid" != "$installed_img_uuid" ]; then
            echo "Updating $core_service_name to image ${latest_img_uuid}"
            sdcadm up -y -C experimental "$core_service_name@$latest_img_uuid"
        else
            echo "$core_service_name is up to date with latest $branch_name"\
                "version"
        fi
    else
        fatal "Could not find latest $core_service_name version built from"\
            "branch $branch_name"
    fi
}

# Install platform with dockerinit changes allowing to automatically mount
# NFS server zones' exported filesystems from Docker containers.
sdcadm platform install -C experimental \
    $(updates-imgadm list -H -o uuid -C experimental name=platform \
        version=~nfsvolumes | tail -1)

# Assign that platform to all CNs
sdcadm platform assign --all \
    $(updates-imgadm list -H -o version -C experimental name=platform \
        version=~nfsvolumes | tail -1 | cut -d'-' -f2)

echo "Making sure sdcadm is up to date..."
sdcadm_installed_version=$(sdcadm --version | cut -d ' ' -f 3 | tr -d '()')
echo "Current sdcadm version: $sdcadm_installed_version"
latest_sdcadm_tritonnfs_img=$(get_latest_img_uuid "sdcadm" "tritonnfs")
if [ "x$latest_sdcadm_tritonnfs_img" != "x" ]; then
    latest_sdcadm_tritonnfs_img_buildstamp=$(updates-imgadm  -C experimental \
        get "$latest_sdcadm_tritonnfs_img" | json tags.buildstamp)
    if [ "$latest_sdcadm_tritonnfs_img_buildstamp" != \
        "$sdcadm_installed_version" ]; then
        echo "Updating sdcadm to image ${latest_sdcadm_tritonnfs_img}"
        sdcadm self-update -C experimental "$latest_sdcadm_tritonnfs_img"
    else
        echo "sdcadm is up to date on latest tritonnfs version"
    fi
else
    fatal "Could not find latest sdcadm version with tritonnfs support"
fi

upgrade_core_service_to_latest_branch_image "sdc" "tritonnfs"
upgrade_core_service_to_latest_branch_image "workflow" "tritonnfs"
upgrade_core_service_to_latest_branch_image "vmapi" "tritonnfs"
upgrade_core_service_to_latest_branch_image "docker" "tritonnfs"

echo "Enabling experimental VOLAPI service"
sdcadm experimental volapi

echo "Restarting sdc-docker to account for configuration changes..."
/opt/smartdc/bin/sdc-login -l docker svcadm restart config-agent
/opt/smartdc/bin/sdc-login -l docker svcadm restart docker
echo "sdc-docker restarted!"

EOS

echo "VOLAPI setup done, reboot of all CNs is needed before it can be used"