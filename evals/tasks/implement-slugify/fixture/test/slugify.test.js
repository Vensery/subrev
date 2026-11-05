import test from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slugify.js'

test('basic', () => assert.equal(slugify('Hello, World!'), 'hello-world'))
test('collapses and trims whitespace', () => assert.equal(slugify('  Multiple   spaces  '), 'multiple-spaces'))
test('strips diacritics', () => assert.equal(slugify('Café Déjà Vu'), 'cafe-deja-vu'))
test('collapses hyphens and trims them', () => assert.equal(slugify('---a--b---'), 'a-b'))
test('empty string', () => assert.equal(slugify(''), ''))
test('already a slug', () => assert.equal(slugify('Already-slugged'), 'already-slugged'))
test('symbols become one separator', () => assert.equal(slugify('C++ & Rust'), 'c-rust'))
