# Fabric and Forge (experimental, Docker)

The two Java mod loaders. Both blueprints are declared and version-aware,
but they boot under Docker, which this panel does not drive yet. Creating
one succeeds; starting one tells you plainly that the Docker engine is not
configured.

Local installs wire up next: Fabric needs its installer executed, Forge
needs its argument files generated. Until then, run modded Java on Paper
with plugins, or track the changelog. Minekube tunneling will apply to both
once they boot, since both are Java.
