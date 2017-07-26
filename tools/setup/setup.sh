#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2017, Joyent, Inc.
#

# This is the first platform build that integrates the fix for DOCKER-754 that
# brings supports for mounting NFS volumes with dockerinit when Docker zones
# boot.
MINIMUM_SUPPORTED_PLATFORM_VERSION="20160613T123039Z"

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

function cns_need_platform_upgrade
{
    local datacenter_name=$1
    local cns_platform_versions=$(ssh root@$datacenter_name \
        "/opt/smartdc/bin/sdc-oneachnode -j -N -c 'uname -v'" | \
        json -a result.stdout | \
        cut -d '_' -f 2)

    for CN_PLATFORM_VERSION in $cns_platform_versions; do
        if [[ "$CN_PLATFORM_VERSION" < \
            "$MINIMUM_SUPPORTED_PLATFORM_VERSION" ]]; then
            return 0
        fi
    done

    return 1
}

function coal_needs_platform_upgrade
{
    local coal_headnode_platform_version=$(ssh root@$datacenter_name uname -v | \
        cut -d '_' -f 2)

    if [[ "$coal_headnode_platform_version" < \
            "$MINIMUM_SUPPORTED_PLATFORM_VERSION" ]]; then
        return 0
    else
        return 1
    fi
}

function upgrade_platform_to_latest_master
{
    local datacenter_name=$1
    local latest_master_platform_uuid_and_version
    local latest_master_platform_uuid
    local latest_master_platform_version

    echo "Upgrading platform to latest master on all CNs..."

    latest_master_platform_uuid_and_version=$(ssh root@$datacenter_name \
        /opt/smartdc/bin/updates-imgadm list -H -o uuid,version name=platform \
        version=~master | tail -1)
    latest_master_platform_uuid=$(echo $latest_master_platform_uuid_and_version\
        | cut -d ' ' -f 1)
    latest_master_platform_version=$(echo $latest_master_platform_uuid_and_version\
        | cut -d ' ' -f 2 | cut -d '-' -f 2)

    echo "Installing latest master platform..."
    ssh root@$datacenter_name /opt/smartdc/bin/sdcadm platform install \
        "$latest_master_platform_uuid"

    echo "Assigning latest master platform to all CNs..."
    ssh root@$datacenter_name /opt/smartdc/bin/sdcadm platform assign --all \
        $latest_master_platform_version

    echo "Platform upgrade done, please reboot all CNs in order for " \
        "them to boot with the new installed platform."
}

function check_platform_supports_nfs_volumes
{
    local datacenter_name=$1
    local proceed_with_upgrade=""
    local need_platform_upgrade=0

    if [[ "$datacenter_name" == "coal" ]]; then
        if coal_needs_platform_upgrade; then
            need_platform_upgrade=1
        fi
    elif cns_need_platform_upgrade "$datacenter_name"; then
        need_platform_upgrade=1
    fi

    if [[ $need_platform_upgrade -eq 1 ]]; then
        echo "Current installed platform is older than minimum supported" \
            "platform on at least 1 CN."
        printf "Do you want to upgrade to latest master platform on all CNs" \
            "[y/N]"

        read proceed_with_upgrade
        echo ""

        if [[ "$proceed_with_upgrade" == "y" || \
            "$proceed_with_upgrade" == "Y" ]]; then
            upgrade_platform_to_latest_master "$datacenter_name"
        else
            echo "A platform that supports NFS volumes is needed to use "\
                "VOLAPI, exiting."
            exit 0
        fi
    else
        echo "Current installed platform supports NFS volumes, not upgrading."
    fi
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

check_platform_supports_nfs_volumes "$datacenter_name"

ssh root@"$datacenter_name" TRACE="$TRACE" /bin/bash -l << "EOS"
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
    local branch_img_uuid
    local latest_branch_img_uuid

    images=$(/opt/smartdc/bin/updates-imgadm -H -C experimental \
        list name=$image_name | cut -d ' ' -f 1)
    # Find latest image with a name that matches $image_name created from a
    # branch whose name matches $branch_pattern. It is currently assumed that
    # the output of updates-imgadm list is sorted by publishing date.
    for IMG in ${images};\
    do
        branch_img_uuid=$(updates-imgadm -C experimental get "${IMG}" | \
            json -c "(version != null && \
            version.indexOf('"${branch_pattern}"') !== -1) || \
            (tags != null && tags.buildstamp != null && \
            tags.buildstamp.indexOf('"${branch_pattern}"') !== -1)" uuid)
        if [[ "$branch_img_uuid" != "" ]]; then
            latest_branch_img_uuid=$branch_img_uuid
        fi
    done

    echo "$latest_branch_img_uuid"
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

function upgrade_gz_tools_to_latest_branch_image
{
    local branch_name=$1

    local latest_img_uuid

    latest_img_uuid=$(get_latest_img_uuid gz-tools "$branch_name")
    if [ "x$latest_img_uuid" != "x" ]; then
        echo "Updating gz-tools to image ${latest_img_uuid}"
        sdcadm experimental update-gz-tools -C experimental "$latest_img_uuid"
    else
        fatal "Could not find latest gz-tools version built from"\
            "branch $branch_name"
    fi
}

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

echo "Setting up VOLAPI service"
sdcadm post-setup volapi

upgrade_core_service_to_latest_branch_image "sdc" "tritonnfs"
upgrade_core_service_to_latest_branch_image "workflow" "tritonnfs"
upgrade_core_service_to_latest_branch_image "vmapi" "tritonnfs"
upgrade_core_service_to_latest_branch_image "docker" "tritonnfs"
upgrade_core_service_to_latest_branch_image "cloudapi" "tritonnfs"

# The VOLAPI service may have been already enabled by "sdcadm experimental
# volapi" but the VOLAPI zone may need to be updated to the latest version.
upgrade_core_service_to_latest_branch_image "volapi" "tritonnfs"

# Needed to add additional programs in the HN's GZ, such as sdc-volapi
upgrade_gz_tools_to_latest_branch_image tritonnfs

# Now enable the experimental_nfs_shared_volumes flag in SAPI
sdcadm experimental nfs-volumes

EOS

echo "VOLAPI setup done, reboot of all CNs is needed before it can be used"