---
sidebar_position: 1
---

# Bundler support

taintwire 0.1.1 has no bundler support: files added to a graph aren't linked to each other, so a value read through a webpack or Turbopack module registry doesn't flow into the chunk that defines it.

Cross-chunk linking (`addFiles()`) arrived in 0.2.0. See the [Next](/next/bundlers) docs.
