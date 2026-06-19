# Phase Model

This document resolves the recurring confusion around:

- blueprint
- kit
- package
- tool
- consumer
- workspace

The right answer is:

they are not all different ontology classes.

Most of them are the same underlying object viewed at different phases or through different projections.

## Core Claim

There should be one canonical persisted object:

`SequenceDocument`

A `SequenceDocument` is:

- a sequence of statements
- with optional schema/constraint declarations
- with optional unresolved gaps
- with optional exports
- with optional methods / callable declarations
- with provenance and history

Everything else is a role, phase, or projection of this object.

## What Actually Collapses

The following are the same underlying thing:

### Blueprint

A `SequenceDocument` intended to be instantiated.

It contains:

- constructor requirements
- defaults
- exported methods/tools
- documentation

### Kit

A `SequenceDocument` representing a partial instantiation.

It is a blueprint plus some bound values, with some gaps still open.

### Package

A `SequenceDocument` representing a committed instantiation.

It is a kit whose required installation gaps are sufficiently resolved to persist and reuse.

So:

- blueprint = instantiable document
- kit = partially applied document
- package = committed applied document

These are phase distinctions, not deep type distinctions.

## What Does Not Collapse

These are not the same kind of thing:

### Tool

A tool is not the persisted object itself.

A tool is a compiled callable projection of a committed or active document.

One document may project zero, one, or many tools.

So:

- package/document = source object
- tool = executable projection

### Consumer

A consumer is not an object of the same class.

A consumer is a relationship:

`Document A depends on exports/projections from Document B`

The consumer set is a reverse dependency projection over the graph.

### Workspace

A workspace is not another installable document.

A workspace is an evaluation context containing:

- visible documents
- active bindings
- compiled projections
- local state
- task/session state

The workspace is the arena in which documents are read, compiled, invoked, and updated.

## The Three Axes You Need

The confusion happened because one axis was doing the job of three.

You need to model objects across:

### 1. Representation Axis

What is the thing made of?

Answer:

- statements
- constraints
- gaps
- exports
- history

This is the `SequenceDocument`.

### 2. Lifecycle Axis

What phase is this document in?

Answer:

1. `spec`
2. `draft`
3. `committed`
4. `active`
5. `obsolete`

Mapping:

- blueprint = `spec`
- kit = `draft`
- package = `committed`

### 3. Projection Axis

How are we viewing or using the document right now?

Answer:

- as a form
- as a document
- as a callable toolset
- as a dependency source
- as a dependency target
- as an event/history stream

This is where tools and consumers belong.

## Canonical Model

The clean model is:

### Object

`SequenceDocument`

Fields:

- `id`
- `phase`
- `body`
- `constraints`
- `gaps`
- `exports`
- `provenance`
- `history`

### Derived Projections

- `InstallFormProjection`
- `DocumentProjection`
- `ToolProjection`
- `ConsumerProjection`
- `EventProjection`

### Context

`Workspace`

Contains:

- visible documents
- active documents
- compiled projections
- local/session/task bindings

## Why Your Earlier Intuition Was Right

You kept noticing that:

- kits looked like documents
- blueprints looked like documents
- packages looked like documents
- type events already formed arrays of patches
- form rendering kept wanting block/document structure

That was not drift.

That was the system telling you the canonical persisted unit is document-like and sequential, not a pile of separate object classes.

## Why The Explosion Happened Anyway

The explosion came from trying to make one layer do all of these at once:

1. structural validation
2. patch/history semantics
3. narrative/document rendering
4. function/provenance constraints
5. gap solving
6. compilation to tools
7. workspace evaluation

Those should share a substrate, but they should not all be encoded as one undifferentiated type object.

## The Sharp Boundaries

To keep the collapse without losing clarity:

### 1. Persist only documents

The database stores `SequenceDocument`s and their histories.

### 2. Compile tools from documents

Tools are ephemeral or cacheable projections from documents.

### 3. Render forms from gaps

A kit form is a projection of unresolved named gaps over a document.

### 4. Compute consumers from dependency edges

Consumers are reverse references, not primary persisted object kinds.

### 5. Use workspaces as contexts

Workspaces hold active compiled projections and local bindings.

They are not just another document.

## Practical Translation

If you need naming that matches the product without lying about the model:

- `Blueprint` = document tagged `phase=spec`
- `KitDraft` = document tagged `phase=draft`
- `InstalledPackage` = document tagged `phase=committed`
- `Tool` = compiled export projection from a document
- `Consumer` = reverse dependency projection
- `Workspace` = evaluation context over documents and projections

## What To Stop Doing

Do not keep asking whether blueprint vs kit vs package are "really different objects."

They are mostly not.

Ask instead:

1. what phase is this document in?
2. what projection am I looking at?
3. what context is evaluating it?

Those are the real distinctions.

## Minimal Rule Set

If you want the shortest possible rule set:

1. The database stores documents, not tools.
2. A blueprint, kit, and package are the same document across lifecycle phases.
3. A tool is a compiled projection of a document export.
4. A consumer is a dependency relation, not a base entity.
5. A workspace is an evaluation context over documents and tool projections.

That is the model that preserves your collapse without turning everything into mush.



────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ THESE PROVIDENCE AMENDMENTS WERE EXACTLY THE IDENTITY KIND BEHAVIORAL CONSTRAINTS I TOLD YOU TO FKN DO. AND WHAT 
  IS DIFFERENT THEN SAYING:
  
  type OpenAPIKey<ContractKey>  = ContractKey && {                              
  validateOpenKey.input<ContractKey> && validateOpenKey.output<ContractKey>.output && true  } ; OR, CONVERSELY:


KeySnapshotStatus<KeyManager: ContractKeyManager> = [
  <key: ContractKey, contract: ContractID> // represents required missing _sequence level state binding_
  KeyManager
  ContractFailure | APIKeyContract
]

ContractKeySnapshot<capabilities: Array<ContractValidators>> = [
  KeySnapshotStatus<capabilities>
]

  createKeyManager(capabilities)
] : ContractKeyManager

Declare<typename: string, othertype, recipe> = [
  << string.segment(typename).segment(othertype)] = othertype & recipe,

]

<TypeName>Validator




  
  \n OpenAPIKey =             
  AttemptedOpenAPIKey where validateOpenAPIKey 