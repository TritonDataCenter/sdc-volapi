#!/usr/bin/bash
# -*- mode: shell-script; fill-column: 80; -*-
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2016, Joyent, Inc.
#

export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
set -o xtrace

service_name='volapi'

echo "Updating SMF manifests"
$(/opt/local/bin/gsed -i"" -e "s/@@PREFIX@@/\/opt\/smartdc\/${service_name}/g" /opt/smartdc/${service_name}/smf/manifests/${service_name}.xml)
$(/opt/local/bin/gsed -i"" -e "s/@@PREFIX@@/\/opt\/smartdc\/${service_name}/g" /opt/smartdc/${service_name}/smf/manifests/${service_name}-updater.xml)

echo "Importing ${service_name}.xml"
/usr/sbin/svccfg import /opt/smartdc/${service_name}/smf/manifests/${service_name}.xml

echo "Importing ${service_name}-updater.xml"
/usr/sbin/svccfg import /opt/smartdc/${service_name}/smf/manifests/${service_name}-updater.xml

exit 0
