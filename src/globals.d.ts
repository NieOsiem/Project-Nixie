/**
 * Foundry and PIXI globals.
 *
 * Deliberately untyped. Everything that touches these lives in src/adapter, which is
 * the boundary we accept as unsafe; src/core is strict and imports none of them.
 * Pulling in community Foundry typings would tie us to one generation, which is the
 * opposite of what the adapter exists to prevent.
 */

declare const PIXI: any;
declare const canvas: any;
declare const game: any;
declare const ui: any;
declare const Hooks: any;
declare const CONFIG: any;
declare const CONST: any;
declare const foundry: any;
