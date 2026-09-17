# Files

The Files tab browses and edits the server directory. Every path is confined
to that directory: `..` escapes, absolute paths, and anything outside are
refused before touching disk.

## Reading and writing

Click a folder to enter it, a file to open it in the editor. Text files up to
2 MB open for editing; anything that looks binary refuses with an explanation
instead of garbage. Saving writes the whole file back. `server.properties`
has its own shortcut button because you will open it constantly.

## Permissions

Listing needs `file.read`, opening needs `file.read-content`, writing needs
`file.update`, creating folders needs `file.create`, deleting needs
`file.delete`. Suspended servers refuse all writes, and collaborators lose
read access too until unsuspension.
