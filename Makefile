#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2022 Joyent, Inc.
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
ESLINT_FILES   = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf
NAME = volapi
SMF_MANIFESTS_IN = smf/manifests/$(NAME)-server.xml.in smf/manifests/$(NAME)-updater.xml.in

NODE_PREBUILT_VERSION=v6.17.1

ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG=zone64
	NODE_PREBUILT_IMAGE=a7199134-7e94-11ec-be67-db6f482136c2
endif

ENGBLD_USE_BUILDIMAGE	= true
ENGBLD_REQUIRE		:= $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

BUILD_PLATFORM  = 20210826T002459Z

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.defs
else
	NPM=npm
	NODE=node
	NPM_EXEC=$(shell which npm)
	NODE_EXEC=$(shell which node)
endif
include ./deps/eng/tools/mk/Makefile.smf.defs

ROOT            := $(shell pwd)
RELEASE_TARBALL := $(NAME)-pkg-$(STAMP).tar.gz
RELSTAGEDIR     := /tmp/$(NAME)-$(STAMP)

# our base image is triton-origin-x86_64-21.4.0
BASE_IMAGE_UUID = 502eeef2-8267-489f-b19c-a206906f57ef
BUILDIMAGE_NAME = $(NAME)
BUILDIMAGE_DESC	= SDC Volumes API
AGENTS		= amon config registrar

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) | $(TAP) sdc-scripts
	$(NPM) rebuild

$(TAP): | $(NPM_EXEC)
	$(NPM) install

CLEAN_FILES += $(TAP) ./node_modules/tap

.PHONY: release
release: all deps docs $(SMF_MANIFESTS)
	@echo "Building $(RELEASE_TARBALL)"
	@mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build
	@mkdir -p $(RELSTAGEDIR)/site
	@touch $(RELSTAGEDIR)/site/.do-not-delete-me
	cp -PR $(NODE_INSTALL) $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/build/node
	cp -r $(ROOT)/lib \
    $(ROOT)/server.js \
    $(ROOT)/volapi-updater.js \
    $(ROOT)/Makefile \
    $(ROOT)/node_modules \
    $(ROOT)/package.json \
    $(ROOT)/sapi_manifests \
    $(ROOT)/smf \
    $(ROOT)/test \
    $(ROOT)/tools \
    $(RELSTAGEDIR)/root/opt/smartdc/$(NAME)/
	mkdir -p $(RELSTAGEDIR)/root/opt/smartdc/boot
	cp -R $(ROOT)/deps/sdc-scripts/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	cp -R $(ROOT)/boot/* $(RELSTAGEDIR)/root/opt/smartdc/boot/
	(cd $(RELSTAGEDIR) && $(TAR) -I pigz -cf $(ROOT)/$(RELEASE_TARBALL) root site)
	@rm -rf $(RELSTAGEDIR)


.PHONY: publish
publish: release
	mkdir -p $(ENGBLD_BITS_DIR)/$(NAME)
	cp $(ROOT)/$(RELEASE_TARBALL) $(ENGBLD_BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

.PHONY: test-coal
COAL=root@10.99.99.7
test-coal:
	./tools/rsync-to coal
	ssh $(COAL) "/opt/smartdc/bin/sdc-login -l ${NAME} /opt/smartdc/${NAME}/test/runtests"

include ./deps/eng/tools/mk/Makefile.deps
ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
	include ./deps/eng/tools/mk/Makefile.agent_prebuilt.targ
else
	include ./deps/eng/tools/mk/Makefile.node.targ
endif
include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.targ

.PHONY: setup-coal
setup-coal:
	sh tools/setup/coal-setup.sh

.PHONY: test-integration-in-coal
test-integration-in-coal:
	@ssh root@coal 'LOG_LEVEL=$(LOG_LEVEL) /zones/$$(vmadm lookup -1 alias=volapi0)/root/opt/smartdc/volapi/test/runtests $(TEST_ARGS)'

.PHONY: test
test: test-integration-in-coal

sdc-scripts: deps/sdc-scripts/.git
