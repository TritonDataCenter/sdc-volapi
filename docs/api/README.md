<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
**Table of Contents**  *generated with [DocToc](https://github.com/thlorenz/doctoc)*

- [VOLAPI API](#volapi-api)
  - [Volume objects](#volume-objects)
    - [Common layout](#common-layout)
    - [Naming constraints](#naming-constraints)
      - [Uniqueness](#uniqueness)
      - [Renaming](#renaming)
    - [Type-specific properties](#type-specific-properties)
    - [Deletion and usage semantics](#deletion-and-usage-semantics)
    - [Volumes state machine](#volumes-state-machine)
    - [ListVolumes GET /volumes](#listvolumes-get-volumes)
      - [Input](#input)
        - [Searching by name](#searching-by-name)
        - [Searching by predicate](#searching-by-predicate)
      - [Output](#output)
    - [GetVolume GET /volumes/volume-uuid](#getvolume-get-volumesvolume-uuid)
      - [Input](#input-1)
      - [Output](#output-1)
    - [CreateVolume POST /volumes](#createvolume-post-volumes)
      - [Input](#input-2)
      - [Output](#output-2)
    - [DeleteVolume DELETE /volumes/volume-uuid](#deletevolume-delete-volumesvolume-uuid)
      - [Input](#input-3)
      - [Output](#output-3)
    - [UpdateVolume POST /volumes/volume-uuid](#updatevolume-post-volumesvolume-uuid)
      - [Input](#input-4)
      - [Output](#output-4)
    - [ListVolumeSizes GET /volumesizes](#listvolumesizes-get-volumesizes)
      - [Input](#input-5)
      - [Output](#output-5)
  - [Volume references](#volume-references)
    - [GetVolumeReferences GET /volumes/uuid/references](#getvolumereferences-get-volumesuuidreferences)
      - [Output](#output-6)
  - [Volume reservations](#volume-reservations)
    - [Volume reservation objects](#volume-reservation-objects)
    - [Volume reservations' lifecycle](#volume-reservations-lifecycle)
    - [CreateVolumeReservation POST /volumereservations](#createvolumereservation-post-volumereservations)
      - [Input](#input-6)
      - [Output](#output-7)
    - [DeleteVolumeReservation DELETE /volumereservations/uuid](#deletevolumereservation-delete-volumereservationsuuid)
      - [Input](#input-7)
      - [Output](#output-8)
    - [ListVolumeReservations GET /volumereservations](#listvolumereservations-get-volumereservations)
      - [Input](#input-8)
      - [Output](#output-9)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

# VOLAPI API

## Volume objects

### Common layout

Volumes are be represented as objects that share a common set of properties:

```
{
  "uuid": "some-uuid",
  "owner_uuid": "some-uuid",
  "name": "foo",
  "type": "tritonnfs",
  "create_timestamp": 1462802062480,
  "state": "created",
  "snapshots": [
    {
      "name": "my-first-snapshot",
      "create_timestamp": "1562802062480",
      "state": "created"
    },
    {
      "name": "my-second-snapshot",
      "create_timestamp": "1572802062480",
      "state": "created"
    }
  ],
  tags: {
    "foo": "bar",
    "bar": "baz"
  }
}
```

* `uuid`: the UUID of the volume itself.

* `owner_uuid`: the UUID of the volume's owner. In the example of a NFS shared
  volume, the owner is the user who created the volume using the `docker volume
  create` command.

* `name`: the volume's name. It must be unique for a given user. This is similar
  to the `alias` property of VMAPI's VM objects. It must match the regular
  expression `/^[a-zA-Z0-9][a-zA-Z0-9_\.\-]+$/`. The maximum number of
  characters for a volume name is 256.

* `type`: identifies the volume's type. There is currently one possible value
  for this property: `tritonnfs`. Additional types can be added in the future,
  and they can all have different sets of [type specific
  properties](#type-specific-properties).

* `create_timestamp`: a timestamp that indicates the time at which the volume
  was created.

* `state`: `creating`, `ready`, `deleting`, `deleted` or `failed`. Indicates in
  which state the volume currently is. `failed` volumes are still persisted to
  Moray for troubleshooting/debugging purposes. See the section [Volumes state
  machine](#volumes-state-machine) for a diagram and further details about the
  volumes' state machine.

* `networks`: a list of network UUIDs that represents the networks on which this
  volume can be reached.

* `refs`: (for "references") a list of VM UUIds that reference this volume. See
  the [volume references section](#volume-references) for more information.

### Naming constraints

#### Uniqueness

Volume names need to be __unique per account__.

#### Renaming

Renaming a volume is not allowed for volumes that are referenced by active VMs.

### Type-specific properties

Different volume types may need to store different properties in addition to the
properties listed above. For instance, "tritonnfs" volumes have the following
extra properties:

* `filesystem_path`: the path that can be used by a NFS client to mount the NFS
  remote filesystem in the host's filesystem.
* `vm_uuid`: the UUID of the Triton VM running the NFS server that exports the
  actual storage provided by this volume.
* `size`: a Number representing the storage size available for this volume, in
  mebibytes.

### Deletion and usage semantics

A volume is considered to be "in use" if the
[`GetVolumeReferences`](#getvolumereferences-get-volumesvolume-uuidreferences-1)
endpoint doesn't return an empty list of VM UUIDs. When a container which mounts
shared volumes is created and becomes "active", it is added as a "reference" to
those shared volumes.

A container is considered to be active when it's in any state except `failed`
and `destroyed` -- in other words in any state that can transition to `running`.

For instance, even if a _stopped_ container is the only remaining container that
references a given shared volume, it won't be possible to delete that volume
until that container is _deleted_.

Deleting a shared volume when there's still at least one active container that
references it will result in an error. This is in line with [Docker's API's
documentation about deleting
volumes](https://docs.docker.com/engine/reference/api/docker_remote_api_v1.23/#remove-a-volume).

A shared volume can be deleted if its only users are mounting it using something
else that Triton APIs (e.g by using the `mount` command manually from within a
VM).

### Volumes state machine

![Volumes state FSM](images/volumes-state-fsm.png)

### ListVolumes GET /volumes

#### Input

| Param           | Type               | Description                              |
| --------------- | ------------------ | ---------------------------------------- |
| name            | String             | Allows to filter volumes by name. |
| size            | Stringified Number | Allows to filter volumes by size. |
| owner_uuid      | String             | When not empty, only volume objects with an owner whose UUID is `owner_uuid` will be included in the output |
| billing_id      | String             | When not empty, only volume objects with a billing\_id whose UUID is `billing_id` will be included in the output |
| type            | String             | Allows to filter volumes by type, e.g `type=tritonnfs`. |
| state           | String             | Allows to filter volumes by state, e.g `state=failed`. |
| predicate       | String             | URL encoded JSON string representing a JavaScript object that can be used to build a LDAP filter. This LDAP filter can search for volumes on arbitrary indexed properties. More details below. |
| vm_uuid      | String             | Allows to get the volume whose storage VM's uuid is `vm_uuid`. This applies to NFS volumes, and may not apply to other types of volumes in the future |

##### Searching by name

`name` is a string containing either a full volume name or a partial volume name
prefixed and/or suffixed with a `*` character. For example:

 * foo
 * foo\*
 * \*foo
 * \*foo\*

are all valid `name=` searches which will match respectively:

 * the exact name `foo`
 * any name that starts with `foo` such as `foobar`
 * any name that ends with `foo` such as `barfoo`
 * any name that contains `foo` such as `barfoobar`

##### Searching by predicate

The `predicate` parameter is a JSON string that can be transformed into an LDAP filter to search
on the following indexed properties:

* `name`
* `owner_uuid`
* `type`
* `size`
* `state`

Important: when using a predicate, you cannot include the same parameter in both
the predicate and the non-predicate query parameters. For example, if your
predicate includes any checks on the `name` field, passing the `name=` query
paramter is an error.

#### Output

A list of volume objects of the following form:

```
[
  {
    "uuid": "e435d72a-2498-8d49-a042-87b222a8b63f",
    "name": "my-volume",
    "owner_uuid": "ae35672a-9498-ed41-b017-82b221a8c63f",
    "size": 10240,
    "type": "tritonnfs",
    "filesystem_path": "host:port/path",
    "state": "ready",
    "networks": [
      "1537d72a-949a-2d89-7049-17b2f2a8b634"
    ],
    "create_timestamp": "2017-11-16T17:31:56.763Z"
  },
  ...
]
```

### GetVolume GET /volumes/volume-uuid

GetVolume can be used to get data from an already created volume, or to
determine when a volume being created is ready to be used.

#### Input

| Param           | Type         | Description                     |
| --------------- | ------------ | --------------------------------|
| uuid            | String       | The uuid of the volume object   |
| owner_uuid      | String       | The uuid of the volume's owner  |

#### Output

A [volume object](#volume-objects) representing the volume with UUID `uuid`.

### CreateVolume POST /volumes

#### Input

| Param         | Type         | Description                              |
| ------------- | ------------ | ---------------------------------------- |
| name          | String       | The desired name for the volume. If missing, a unique name for the current user will be generated. Names cannot be longer than 256 characters |
| owner_uuid    | String       | The UUID of the volume's owner. |
| size          | Number       | The desired storage capacity for that volume in mebibytes. Default value is 10240 mebibytes (10 gibibytes). |
| type          | String       | The type of volume. Currently only `'tritonnfs'` is supported. |
| networks      | Array        | A list of UUIDs representing networks on which the volume will be reachable. These networks must be owned by the user with UUID `owner_uuid` and must be fabric networks. |

#### Output

A [volume object](#volume-objects) representing the volume with UUID `uuid`. The
`state` property of the volume object is either `creating` or `failed`.

If the `state` property of the newly created volume is `creating`, sending
`GetVolume` requests periodically can be used to determine when the volume is
either ready to use (`state` === `'ready'`) or when it failed to be created
(`state` === `'failed'`).

### DeleteVolume DELETE /volumes/volume-uuid

#### Input

| Param         | Type        | Description                     |
| ------------- | ----------- | --------------------------------|
| owner_uuid    | String      | The UUID of the volume's owner. |
| uuid          | String      | The uuid of the volume object   |
| force         | Boolean     | If true, the volume can be deleted even if there are still non-deleted containers that reference it .   |

If `force` is not specified or `false`, deletion of a shared volume is not
allowed if it has at least one "active user". If `force` is true, a shared
volume can be deleted even if it has active users.

See the section ["Deletion and usage semantics"](#deletion-and-usage-semantics)
for more information.

#### Output

The output is empty and the status code is 204 if the deletion was scheduled
successfully.

A volume is always deleted asynchronously. In order to determine when the volume
is actually deleted, users need to poll the volume's `state` property.

If resources are using the volume to be deleted, the request results in an error
and the error contains a list of resources that are using the volume.

### UpdateVolume POST /volumes/volume-uuid

The UpdateVolume endpoint can be used to update the following properties of a
shared volume:

* `name`, to rename a volume. See [the section on renaming volumes](#renaming)
  for further details.

#### Input

| Param      | Type   | Description                                 |
| -----------|--------| --------------------------------------------|
| owner_uuid | String | The UUID of the volume's owner              |
| uuid       | String | The uuid of the volume object               |
| name       | String | The new name of the volume with uuid `uuid` |

#### Output

If users need to get an updated representation of the volume, they can send a
`GetVolume` request.

### ListVolumeSizes GET /volumesizes

The `ListVolumeSizes` endpoint can be used to determine in what sizes volumes of
a certain type are available.

#### Input

| Param    | Type         | Description                     |
| -------- | ------------ | --------------------------------|
| type     | String       | the type of the volume (e.g `tritonnfs`). Default value is `tritonnfs` |

Sending any other input parameter will result in an error.

#### Output

The response is an array of objects having two properties:

* `size`: a number in mebibytes that represents the size of a volume

* `type`: the type of volume for which the size is available

```
[
  {
    "size": 10240,
    "type": "tritonnfs"
  },
  {
    "size": 20480,
    "type": "tritonnfs"
  },
  {
    "size": 30720,
    "type": "tritonnfs"
  },
  {
    "size": 40960,
    "type": "tritonnfs"
  },
  {
    "size": 51200,
    "type": "tritonnfs"
  },
  {
    "size": 61440,
    "type": "tritonnfs"
  },
  {
    "size": 71680,
    "type": "tritonnfs"
  },
  {
    "size": 81920,
    "type": "tritonnfs"
  },
  {
    "size": 92160,
    "type": "tritonnfs"
  },
  {
    "size": 102400,
    "type": "tritonnfs"
  },
  {
    "size": 204800,
    "type": "tritonnfs"
  },
  {
    "size": 307200,
    "type": "tritonnfs"
  },
  {
    "size": 409600,
    "type": "tritonnfs"
  },
  {
    "size": 512000,
    "type": "tritonnfs"
  },
  {
    "size": 614400,
    "type": "tritonnfs"
  },
  {
    "size": 716800,
    "type": "tritonnfs"
  },
  {
    "size": 819200,
    "type": "tritonnfs"
  },
  {
    "size": 921600,
    "type": "tritonnfs"
  },
  {
    "size": 1024000,
    "type": "tritonnfs"
  }
]
```

## Volume references

Volume references represent a relation of usage between VMs and volumes. A VM is
considered to "use" a volume when it mounts it on startup. A VM can be made to
mount a volume on startup by using he `volumes` input parameter of the
`CreateVm` VMAPI API.

References are represented in volume objects by a `refs` property. It is an
array of VM UUIDs. All VM UUIDs in this array are said to reference the volume
object.

When a volume is referenced by at least one VM, it cannot be deleted, unless the
`force` parameter of the `DeleteVolume` API is set to `true`.

When a VM that references a volume becomes inactive, its reference to that
volume is automatically removed. If it becomes active again, it is automatically
added.

### GetVolumeReferences GET /volumes/uuid/references

`GetVolumeReferences` can be used to list VMs that are using the volume with
UUID `uuid`.

#### Output

A list of VM UUIDs that are using the volume with UUID `uuid`:

```
[
   "a495d72a-2498-8d49-a042-87b222a8b63c",
   "b135a72a-1438-2829-aa42-17b231a6b63e"
]
```

## Volume reservations

Volume references are useful to represent a "usage" relationship between
_existing_ VMs and volumes. However, sometimes there's a need to represent a
_future_ usage relationship between volumes and VMs that do not exist yet.

When volumes are linked to the VM which mounts them at creation time, the
volume(s) are created _before_ the VM that mounts them is created.

Indeed, since the existence of the VM is tied to the existence of the volumes it
mounts, it wouldn't make sense to create it before all of its volumes are ready
to be used.

However, having the volumes created _before_ the VM that mounts them means that
there is a window of time during which the volumes are not referenced by any
active VM. As such, they could be deleted before the provisioning workflow job
of the VM that mounts them completes and the VM becomes active.

_Volume reservations_ are the abstraction that allows a VM that does not exist
yet to reference one or more volumes, and prevents those volumes from being
deleted until the provisioning job fails or the VM becomes inactive.

### Volume reservation objects

Volume reservations are composed of the following attributes:

* `uuid`: the UUID of the reservation object
* `vm_uuid`: the UUID of the VM being created
* `job_uuid`: the UUID of the job that creates the VM
* `owner_uuid`: the UUID of the owner of the VM and the volumes
* `volume_name`: the name of the volume being created
* `create_timestamp`: the time at which the volume reservation was created

### Volume reservations' lifecycle

The workfow of volume reservations can be described as following:

1. The VM provisioning workflow determines the VM being provisioned mounts one
   or more volume, so it creates those volumes

2. Once all the volumes mounted by the VM being provisioned are created, the
   provisoning workflow creates a separate volume reservation for each volume
   mounted

3. The VM starts being provisioned

Once volume reservations are created, it is not possible to delete the volumes
reserved unless one of this condition is valid:

* the force flag is passed to the `DeleteVolume` request
* the VM provisioning job that reserved the volumes completed its execution and failed
* the VM mounting the volumes became inactive

Volume reservations are cleaned up periodically by VOLAPI so that stalled VM
provisioning workflows do not hold volume reservations forever.

Volume reservations are also deleted when a _reference_ from the same VM to the
same volume is created. This happens when:

* the corresponding provisioning workflow job completes successfully
* the VM that mounts reserved volumes becomes active

### CreateVolumeReservation POST /volumereservations

#### Input

| Param         | Type    | Description                           |
| ------------- | ------- | ------------------------------------- |
| volume_name   | String  | The name of the volume being reserved |
| job_uuid      | UUID    | UUID of the job provisioning the VM that mounts the volume |
| owner_uuid    | UUID    | UUID for the owner of the VM with UUID vm\_uuid and the volume with name volume\_name  |
| vm\_uuid      | UUID    | UUID of the VM being provisioned that mounts the volume with name "volume_name" |

#### Output

A [volume reservation object](#volume-reservation-objects) of the following
form:

```
{
  "uuid": "1360ef7d-e831-4351-867a-ea350049a934",
  "volume_name": "input-name",
  "job_uuid": "1db9b975-bd8b-4ed5-9878-fa2a8e45a821",
  "owner_uuid": "725624f8-53a9-4f0b-8f4f-3de8922fc4c8",
  "vm_uuid": "e7bc54f4-00ea-42c3-90c6-c78ee541572d",
  "create_timestamp": "2017-09-07T16:05:17.776Z"
}
```

### DeleteVolumeReservation DELETE /volumereservations/uuid

#### Input

| Param         | Type         | Description                              |
| ------------- | ------------ | ---------------------------------------- |
| uuid          | String       | The uuid of the volume reservation being deleted |
| owner_uuid          | String       | The UUID of the owner associated to that volume reservation |


#### Output

Empty 204 HTTP response.

### ListVolumeReservations GET /volumereservations

#### Input

| Param         | Type         | Description                              |
| ------------- | ------------ | ---------------------------------------- |
| volume_name          | String       | The name of the volume being reserved |
| job_uuid          | UUID       | UUID of the job provisioning the VM that mounts the volume |
| owner_uuid          | UUID       | UUID for the owner of the VM with UUID vm\_uuid and the volume with name volume\_name  |

#### Output

An array of volume reservation objects.