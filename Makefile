#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2016, Joyent, Inc.
#

#
# Tools
#
TAP		:= ./node_modules/.bin/tap

#
# Files
#
#DOC_FILES	 = index.restdown boilerplateapi.restdown
JS_FILES	:= $(shell ls *.js) $(shell find lib tools test -name '*.js')
JSON_FILES	 = package.json
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
SERVICE_NAME     = volapi
SMF_MANIFESTS_IN = smf/manifests/$(SERVICE_NAME).xml.in smf/manifests/$(SERVICE_NAME)-updater.xml.in

NODE_PREBUILT_VERSION=v4.6.1

ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=zone
	# Allow building on other than image sdc-minimal-multiarch-lts@15.4.1.
	NODE_PREBUILT_IMAGE=18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.defs
else
	include ./tools/mk/Makefile.node.defs
endif
include ./tools/mk/Makefile.smf.defs

ROOT            := $(shell pwd)
RELEASE_TARBALL := $(SERVICE_NAME)-pkg-$(STAMP).tar.bz2
RELSTAGEDIR     := /tmp/$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(TAP) $(REPO_DEPS)
	$(NPM) rebuild

$(TAP): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(TAP) ./node_modules/tap

.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(SERVICE_NAME)/build
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	cp -PR $(NODE_INSTALL) $(RELSTAGEDIR)/root/opt/smartdc/$(SERVICE_NAME)/build/node
	cp -r $(ROOT)/lib \
    $(ROOT)/server.js \
    $(ROOT)/volapi-updater.js \
    $(ROOT)/Makefile \
    $(ROOT)/node_modules \
    $(ROOT)/package.json \
    $(ROOT)/sapi_manifests \
    $(ROOT)/smf \
    $(ROOT)/tools \
    $(RELSTAGEDIR)/root/opt/smartdc/$(SERVICE_NAME)/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(ROOT)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(ROOT)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)


.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
    echo "error: 'BITS_DIR' must be set for 'publish' target"; \
    exit 1; \
  fi
	mkdir -p $(BITS_DIR)/$(SERVICE_NAME)
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/$(SERVICE_NAME)/$(RELEASE_TARBALL)

.PHONY: test-coal
COAL=root@10.99.99.7
test-coal:
	./tools/rsync-to coal
	ssh $(COAL) "/opt/smartdc/bin/sdc-login -l ${SERVICE_NAME} /opt/smartdc/${SERVICE_NAME}/test/runtests"

include ./tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./tools/mk/Makefile.node_prebuilt.targ
else
	include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ

.PHONY: setup-coal
setup-coal:
	sh tools/setup/coal-setup.sh

.PHONY: test-integration-in-coal
test-integration-in-coal:
	@ssh root@coal 'LOG_LEVEL=$(LOG_LEVEL) /zones/$$(vmadm lookup -1 alias=volapi0)/root/opt/smartdc/volapi/test/runtests $(TEST_ARGS)'

.PHONY: test
test: test-integration-in-coal