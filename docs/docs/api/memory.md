---
sidebar_position: 7
---

# Memory

A PookieGraph's memory has two parts:

- **Ladybug's buffer pool:** native memory for graph pages and for the working memory of loads and queries.
- **The JS heap:** ASTs and rows while `addFiles()` parses and flattens files.

## Buffer pool and threads

Ladybug's own defaults are a buffer pool of most of the machine's RAM and one query thread per core. Inside a container, "the machine" is the host: Ladybug doesn't read the cgroup limit. Its pool then grows past the container's memory limit, and the container kills the process.

`PookieGraph.open()` defaults to a pool of half of the memory the process may use: the container's limit (`process.constrainedMemory()`) if there is one, otherwise the machine's RAM. The other half is left for the JS heap. It also runs queries on 2 threads (`DEFAULT_THREADS`).

The pool is allocated as it is used, so a smaller cap doesn't save memory on a graph that fits. It only changes what happens when a graph doesn't fit: past the cap, the load or query fails with `Buffer manager exception: ... The buffer pool is full` instead of being killed. That holds for graphs on disk too: Ladybug keeps a query's working memory in the pool. Pass a larger `bufferPoolMB` if there is room, or `0` for Ladybug's own default.

```ts
const g = await PookieGraph.open("app.pg", { bufferPoolMB: 4096, threads: 1 });
```

## JS heap

`addFiles()` parses and flattens all the files it is given at once, so the heap peaks at about every AST and row of those files. During the load, the rows of each table are dropped as soon as the table is copied. To bound the heap, load fewer files per graph.

## One graph per unit

[`moduleLinks()`](reference.md#modulelinks) and [`planUnits()`](reference.md#planunits) split a build into units: each file plus the files that define the modules it loads, transitively. Each unit is loaded as its own graph, one at a time, so the largest unit sets the peak, not the whole build. `js-recon taintwire build -o app.tw` does this. It packs the unit graphs into one `.tw` file, and `taintwire analyze` runs the rules on each graph in turn.

What it costs and misses:

- **Shared files are loaded again.** A shared chunk, such as a framework or vendor chunk, is loaded into every unit that imports it, so building all units takes longer than one linked graph.
- **Some flows between importers are missed.** A value that goes from one importer through a shared module to another importer is only in one linked graph of every file. An example is file A calling `store.set(location.hash)` and file B rendering `store.get()`. Use a single `.pg` for that.
- **Some units are still the whole app.** If an entry chunk `import()`s every lazy chunk, as with `React.lazy`, its unit is the whole app. Only the buffer pool bounds that unit.
- **No registry means one file per unit.** Files with no module registry, such as Vite/esbuild ES modules, are a unit each. That's no loss, because plain ES `import`/`export` isn't linked across files anyway.
