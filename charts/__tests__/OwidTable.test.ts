#! /usr/bin/env yarn jest

import { OwidTable } from "charts/owidData/OwidTable"

describe(OwidTable, () => {
    const rows = [
        {
            year: 2020,
            entityName: "United States",
            population: 3e8,
            entityId: 1,
            entityCode: "USA"
        }
    ]
    const table = new OwidTable(rows)
    it("can create a table and detect columns", () => {
        expect(table.rows.length).toEqual(1)
        expect(Array.from(table.columnsByName.keys()).length).toEqual(5)
    })

    it("a column can be added", () => {
        table.addColumn(
            { slug: "populationInMillions" },
            row => row.population / 1000000
        )
        expect(table.rows[0].populationInMillions).toEqual(300)
    })
})

describe("rolling averages", () => {
    const rows = [
        {
            year: 2020,
            entityName: "United States",
            population: 3e8,
            entityId: 1,
            entityCode: "USA"
        }
    ]
    const table = new OwidTable(rows)
    it("a column can be added", () => {
        expect(table.rows.length).toEqual(1)
        expect(Array.from(table.columnsByName.keys()).length).toEqual(5)
        table.addColumn(
            { slug: "populationInMillions" },
            row => row.population / 1000000
        )
        expect(table.rows[0].populationInMillions).toEqual(300)
        expect(Array.from(table.columnsByName.keys()).length).toEqual(6)
    })
})
