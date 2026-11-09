import { describe, expect, it } from 'vitest'

import { normalizeTaxIdValue, taxIdFieldLabel, taxIdPlaceholder, taxIdTypeLabel, taxIdTypesFor } from './tax-id'

describe('taxIdTypesFor', () => {
    it('puts the intra-community number first in an EU country', () => {
        expect(taxIdTypesFor('FR')).toEqual(['eu_vat'])
        expect(taxIdTypesFor('de')).toEqual(['eu_vat', 'de_stn'])
        expect(taxIdTypesFor('ES')).toEqual(['eu_vat', 'es_cif'])
    })

    it('reads the national types off the type prefix outside the EU', () => {
        expect(taxIdTypesFor('GB')).toEqual(['gb_vat'])
        expect(taxIdTypesFor('CH')).toEqual(['ch_vat', 'ch_uid'])
        expect(taxIdTypesFor('CA')).toEqual(['ca_bn', 'ca_gst_hst', 'ca_pst_bc', 'ca_pst_mb', 'ca_pst_sk', 'ca_qst'])
    })

    it('has nothing for a country Stripe takes no number for, or no country', () => {
        expect(taxIdTypesFor('AQ')).toEqual([])
        expect(taxIdTypesFor(null)).toEqual([])
    })
})

describe('normalizeTaxIdValue', () => {
    it('adds the country prefix an EU number was typed without', () => {
        expect(normalizeTaxIdValue('eu_vat', '123 456 789', 'DE')).toBe('DE123456789')
        expect(normalizeTaxIdValue('eu_vat', '094259216', 'GR')).toBe('EL094259216')
    })

    it('keeps a prefix already there, whatever the case and the separators', () => {
        expect(normalizeTaxIdValue('eu_vat', 'fr 12.345-678 901', 'FR')).toBe('FR12345678901')
        expect(normalizeTaxIdValue('eu_vat', 'DE123456789', 'FR')).toBe('DE123456789')
    })

    it('prefixes a French number whose key is two letters', () => {
        expect(normalizeTaxIdValue('eu_vat', 'AB123456789', 'FR')).toBe('FRAB123456789')
    })

    it('only trims the other types, whose format is not ours to guess', () => {
        expect(normalizeTaxIdValue('gb_vat', '  GB123456789 ', 'GB')).toBe('GB123456789')
        expect(normalizeTaxIdValue('ca_bn', '123456789', 'CA')).toBe('123456789')
    })
})

describe('labels', () => {
    it('names a VAT number as such, anything else a tax ID', () => {
        expect(taxIdFieldLabel('eu_vat')).toBe('VAT number')
        expect(taxIdFieldLabel('us_ein')).toBe('Tax ID')
        expect(taxIdFieldLabel(undefined)).toBe('Tax ID')
    })

    it('reads the kind of a type off its suffix', () => {
        expect(taxIdTypeLabel('ca_gst_hst')).toBe('GST HST')
        expect(taxIdTypeLabel('ch_uid')).toBe('UID')
    })

    it('suggests the prefixed format for an EU number only', () => {
        expect(taxIdPlaceholder('eu_vat', 'GR')).toBe('EL123456789')
        expect(taxIdPlaceholder('us_ein', 'US')).toBeUndefined()
    })
})
