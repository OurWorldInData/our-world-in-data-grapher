#! /usr/bin/env jest

import { CoreTable } from "./CoreTable"
import { TransformType } from "./CoreTableConstants"
import { ColumnTypeNames } from "./CoreColumnDef"
import { ErrorValueTypes, isNotErrorValue } from "./ErrorValues"

const sampleCsv = `country,population
iceland,1
france,50
usa,300
canada,20`

describe("creating tables", () => {
    it("can create tables from csv", () => {
        const table = new CoreTable(sampleCsv)
        expect(table.numRows).toEqual(4)
        expect(table.columnNames).toEqual(["country", "population"])
    })

    it("can create tables from csv with columns definitions also as csv", () => {
        const table = new CoreTable(
            sampleCsv,
            `slug,name
country,Region
population,Population in 2020`
        )
        expect(table.numRows).toEqual(4)
        expect(table.columnNames).toEqual(["Region", "Population in 2020"])
    })

    describe("transforms", () => {
        it("can create columns from transforms", () => {
            const table = new CoreTable(
                sampleCsv,
                `slug,name,transform
country,Region,
population,Population in 2020,
popTimes10,Pop times 10,multiplyBy population 10`
            )
            expect(table.get("popTimes10").valuesIncludingErrorValues).toEqual([
                10,
                500,
                3000,
                200,
            ])
        })

        describe("runs transforms just once", () => {
            const table = new CoreTable(
                `country,population
iceland,1
iceland,2
iceland,3
france,50
france,60
france,75`,
                `slug,name,transform
country,Region,
population,Population in 2020,
popChange,Pop change,percentChange time country population 2`
            )
            const expected = [
                ErrorValueTypes.NoValueToCompareAgainst,
                ErrorValueTypes.NoValueToCompareAgainst,
                200,
                ErrorValueTypes.NoValueToCompareAgainst,
                ErrorValueTypes.NoValueToCompareAgainst,
                50,
            ]
            it("runs transforms correctly", () => {
                expect(
                    table.get("popChange").valuesIncludingErrorValues
                ).toEqual(expected)
            })

            it("runs transforms once", () => {
                expect(
                    table
                        .rowFilter((row, index) => !!index, "drop first")
                        .appendColumns([
                            { slug: "test", values: [1, 1, 1, 1, 1, 1] },
                        ])
                        .get("popChange").valuesIncludingErrorValues
                ).toEqual(expected.slice(1))
            })
        })
    })

    it("can create an empty table", () => {
        expect(new CoreTable().transformCategory).toEqual(
            TransformType.LoadFromRowStore
        )
    })

    it("will only look at properties of the first object literal when autodetecting columns from rows", () => {
        const table = new CoreTable([{ name: "test" }, { score: 123 }])
        expect(table.columnNames).toEqual(["name"])
    })

    it("can combine tables", () => {
        const table = new CoreTable(sampleCsv).concat([
            new CoreTable(sampleCsv),
        ])
        expect(table.numRows).toEqual(8)
    })

    it("can drop empty rows", () => {
        const table = new CoreTable(`country,gdp\nusa,123\n,\n`)
        expect(table.dropEmptyRows().numRows).toEqual(1)
    })

    it("can create a table from columns", () => {
        const table = new CoreTable({
            scores: [0, 1, 2],
            team: ["usa", "france", "canada"],
        })
        expect(table.numRows).toEqual(3)
        expect(table.columnNames).toEqual(["scores", "team"])
    })

    it("can create a table from csv", () => {
        const table = new CoreTable(sampleCsv)
        expect(table.numRows).toEqual(4)
        expect(table.columnNames).toEqual(["country", "population"])
        expect(table.columnTypes).toEqual(["String", "Numeric"])
        expect(table.columnJsTypes).toEqual(["string", "number"])
    })

    it("can handle when a blank column type is provided", () => {
        expect(
            new CoreTable("", [{ slug: "gdp", type: "" as any }]).numRows
        ).toEqual(0)
    })

    it("always parses all values in all rows to Javascript primitives when the table is initially loaded", () => {
        const rows = [
            { country: "USA", gdp: 2000 },
            { country: "Germany", gdp: undefined },
        ]
        const table = new CoreTable(rows)
        expect(table.get("gdp").numValues).toEqual(1)
    })

    it("parses values to the provided type even if first row is missing value", () => {
        const rows = `gdp,country
,usa
123,can`
        const table = new CoreTable(rows, [
            {
                slug: "gdp",
                type: ColumnTypeNames.Numeric,
            },
        ])
        expect(table.get("gdp").maxValue).toEqual(123)
    })

    describe("loading from matrix", () => {
        const sampleRows = [
            {
                year: 2020,
                time: 2020,
                entityName: "United States",
                population: 3e8,
                entityId: 1,
                entityCode: "USA",
            },
        ]
        const matrix = [
            Object.keys(sampleRows[0]),
            Object.values(sampleRows[0]),
        ]
        const table = new CoreTable(matrix)
        expect(table.numRows).toEqual(1)
        expect(table.numColumns).toEqual(6)
        expect(table.toMatrix()).toEqual(matrix)

        it("can delete columns", () => {
            const dropped = table.dropColumns(["entityId"])
            expect(dropped.toMatrix()[0].length).toEqual(5)
        })

        const tableTrim = new CoreTable([
            ["country", null],
            ["usa", undefined],
        ])
        expect(tableTrim.toMatrix()).toEqual([["country"], ["usa"]])
    })

    it("handles ErrorValues when serializing to a matrix", () => {
        const table = new CoreTable([{ country: "usa", gdp: undefined }])
        expect(table.toMatrix()[1][1]).toEqual(undefined)
    })

    it("can transpose a table", () => {
        let table = new CoreTable([
            { fruit: 123, veggies: 234, entity: "usa" },
            { fruit: 456, veggies: 789, entity: "canada" },
            { fruit: 333, veggies: 222, entity: "spain" },
        ])
        table = table.transpose("entity")
        expect(table.columnSlugs).toEqual(["entity", "usa", "canada", "spain"])
        expect(table.numRows).toEqual(2)
        const firstRow = table.firstRow as any
        expect(firstRow.canada).toEqual(456)
    })

    it("can create a table with columns but no rows", () => {
        expect(
            new CoreTable({}, [{ slug: "entityId" }]).get("entityId").values
        ).toEqual([])
    })

    it("can create a table with an empty column", () => {
        const table = new CoreTable(
            [{ color: "blue" }],
            [{ slug: "name", type: ColumnTypeNames.String }]
        )
        expect(table.columnSlugs).toEqual(["name", "color"])
        expect(table.numRows).toEqual(1)
    })
})

describe("set methods", () => {
    it("can find the intersection between 2 tables", () => {
        const table = new CoreTable(sampleCsv)
        expect(table.intersection([new CoreTable(sampleCsv)]).numRows).toEqual(
            4
        )
        expect(table.intersection([new CoreTable()]).numRows).toEqual(0)
        expect(
            table.intersection([new CoreTable(sampleCsv), new CoreTable()])
                .numRows
        ).toEqual(0)
        expect(
            table.intersection([new CoreTable(sampleCsv + "\n" + sampleCsv)])
                .numRows
        ).toEqual(4)
        expect(
            table.intersection([
                new CoreTable(sampleCsv.replace("\ncanada,20", "")),
            ]).numRows
        ).toEqual(3)
    })

    it("can perform a union", () => {
        const table = new CoreTable(sampleCsv)
        expect(table.union([new CoreTable(sampleCsv)]).numRows).toEqual(4)

        expect(
            table.union([
                new CoreTable([{ country: "Mexico", population: 20 }]),
            ]).numRows
        ).toEqual(5)
    })

    it("can perform a diff", () => {
        const table = new CoreTable(sampleCsv)
        expect(table.difference([new CoreTable(sampleCsv)]).numRows).toEqual(0)

        const tb = new CoreTable([{ country: "Mexico", population: 20 }])
        expect(table.difference([tb]).numRows).toEqual(4)

        expect(tb.difference([table]).numRows).toEqual(1)
    })

    it("does not drop any rows if there are no duplicates", () => {
        expect(new CoreTable(sampleCsv).dropDuplicateRows().numRows).toEqual(4)
    })
})

it("can complete a table", () => {
    const csv = `country,year
usa,2000
usa,2002
uk,2001`
    const table = new CoreTable(csv)
    expect(table.numRows).toEqual(3)
    const completed = table.complete(["country", "year"])
    expect(completed.numRows).toEqual(6)
})

describe("adding rows", () => {
    describe("adding rows is immutable", () => {
        const table = new CoreTable(sampleCsv)
        expect(table.numRows).toEqual(4)

        let expandedTable = table.appendRows(
            [{ country: "Japan", population: 123 }],
            `Added 1 row`
        )
        expect(expandedTable.numRows).toBe(5)
        expect(table.numRows).toEqual(4)

        it("can append rows", () => {
            expandedTable = expandedTable
                .renameColumns({ population: "pop" })
                .appendRows(
                    [{ country: "USA", pop: 321 }],
                    "Added a row after column renaming"
                )
            expect(expandedTable.numRows).toEqual(6)
            expect(expandedTable.rows[5].pop).toEqual(321)
        })
    })

    it("can drop rows", () => {
        const table = new CoreTable(sampleCsv)
        expect(table.dropRowsAt([0, 1, 3]).numRows).toEqual(1)
    })
})

describe("column operations", () => {
    it("can add a column from an array", () => {
        let table = new CoreTable({
            scores: [0, 1, 2],
            team: ["usa", "france", "canada"],
        })
        table = table.appendColumns([
            {
                slug: "population",
                values: [100, 200, 300],
            },
        ])
        expect(table.where({ team: "canada" }).rows[0].population).toEqual(300)
    })

    it("can rename a column", () => {
        let table = new CoreTable([{ pop: 123, year: 2000 }])
        table = table.renameColumns({ pop: "Population" })
        expect(table.columnSlugs).toEqual(["Population", "year"])
        const firstRow = table.firstRow as any
        expect(firstRow.Population).toEqual(123)
    })

    it("does not mutate input rows ever", () => {
        const rows = [{ country: "USA" }, { country: "Germany" }]
        const table = new CoreTable(rows, [
            {
                slug: "countryNameLength",
                values: rows.map((row) => row.country.length),
            },
        ])
        expect(table.get("countryNameLength").values.join("")).toEqual(`37`)
        expect((rows[0] as any).countryNameLength).toEqual(undefined)
    })

    it("can drop columns", () => {
        const rows = [
            { country: "USA", year: 1999 },
            { country: "Germany", year: 2000 },
        ]
        const table = new CoreTable(rows)
        expect(table.columnSlugs).toEqual(["country", "year"])
        expect(table.dropColumns(["year"]).columnSlugs).toEqual(["country"])
    })

    it("can keep only a certain set of columns", () => {
        const rows = [
            { country: "USA", year: 1999, gdp: 10001 },
            { country: "Germany", year: 2000, gdp: 20002 },
        ]
        const table = new CoreTable(rows)
        expect(table.columnSlugs).toEqual(["country", "year", "gdp"])
        expect(table.keepOnlyColumns(["country", "gdp"]).columnSlugs).toEqual([
            "country",
            "gdp",
        ])
    })

    it("can transform columns", () => {
        const rows = [
            { country: "USA", year: 1999 },
            { country: "Germany", year: 2000 },
        ]
        const table = new CoreTable(rows)
        expect(table.columnNames).toEqual(["country", "Year"])
        expect(
            table.updateDefs((def) => {
                return {
                    ...def,
                    name: def.slug.toUpperCase(),
                }
            }).columnNames
        ).toEqual(["COUNTRY", "YEAR"])
    })

    it("can sort columns", () => {
        const rows = [
            { country: "USA", year: 1999 },
            { country: "Germany", year: 2000 },
        ]
        const table = new CoreTable(rows)
        expect(table.columnSlugs).toEqual(["country", "year"])
        expect(table.sortColumns(["year", "country"]).columnSlugs).toEqual([
            "year",
            "country",
        ])
    })
})

describe("searching", () => {
    const rows = [
        { country: "USA", year: 1999 },
        { country: "Germany", year: 2000 },
        { country: "Germany", year: 2001 },
    ]
    const table = new CoreTable(rows)

    it("can filter by exact matches to certain columns", () => {
        expect(table.where({ country: "Germany" }).numRows).toEqual(2)
        expect(table.findRows({ country: "Germany" }).length).toEqual(2)
        expect(table.where({ country: "Germany", year: 2001 }).numRows).toEqual(
            1
        )
        expect(table.where({}).numRows).toEqual(3)
        expect(table.where({ country: ["Germany", "USA"] }).numRows).toEqual(3)
        expect(table.where({ year: [2002] }).numRows).toEqual(0)
        expect(
            table.where({ year: [1999], country: "Germany" }).numRows
        ).toEqual(0)
    })

    it("can do grep like searching to find rows", () => {
        expect(table.grep("Germany").numRows).toEqual(2)
        expect(table.grep("USA").numRows).toEqual(1)
        expect(table.grep("USA").numRows).toEqual(1)
        expect(table.grep("Missing").numRows).toEqual(0)
        expect(table.grep("200").numRows).toEqual(2)
        expect(table.grep(/20\d+/).numRows).toEqual(2)

        expect(
            table.grep("Germany").grep("2001").opposite.rows[0].year
        ).toEqual(2000)
        expect(table.grep("Germany").opposite.numRows).toEqual(1)
        expect(table.grep(/(1999|2000)/).numRows).toEqual(2)
    })

    it("can filter columns as well", () => {
        expect(table.grepColumns("country").numColumns).toEqual(1)
        expect(table.grepColumns("r").numColumns).toEqual(2)
        expect(table.grepColumns("zz").numColumns).toEqual(0)
        expect(table.grepColumns("year").oppositeColumns.columnSlugs).toEqual([
            "country",
        ])
        expect(table.grepColumns(/co.+/).oppositeColumns.columnSlugs).toEqual([
            "year",
        ])
    })

    it("can get the domain across all columns", () => {
        const table = new CoreTable(
            `gdp,perCapita
0,123.1
12,300
20,40`,
            [
                { slug: "gdp", type: ColumnTypeNames.Numeric },
                { slug: "perCapita", type: ColumnTypeNames.Numeric },
            ]
        )
        const domainFor = table.domainFor(["gdp", "perCapita"])
        expect(domainFor).toEqual([0, 300])
    })

    it("can get annotations for a row", () => {
        const csv = `entityName,pop,notes,year
usa,322,in hundreds of millions,2000
hi,1,in millions,2000
hi,1,,2001`
        const table = new CoreTable(csv)

        const annotationsColumn = table.get("notes")
        const entityNameMap = annotationsColumn.getUniqueValuesGroupedBy(
            "entityName"
        )

        expect(entityNameMap.size).toEqual(2)
        expect(entityNameMap.get("hi")).toContain("in millions")
        expect(entityNameMap.get("usa")).toContain("in hundreds of millions")
    })
})

describe("filtering", () => {
    describe("row filter", () => {
        const rootTable = new CoreTable(sampleCsv)
        const filteredTable = rootTable.rowFilter(
            (row) => parseInt(row.population) > 40,
            "Pop filter"
        )
        it("can filter", () => {
            expect(rootTable.get("country").values[3]).toEqual("canada")
            const parsedValues = filteredTable.get("country").values
            expect(parsedValues[0]).toEqual("france")
            expect(parsedValues[1]).toEqual("usa")
        })

        it("can chain filters", () => {
            const filteredTwiceTable = filteredTable.rowFilter(
                (row: any) => (row.country as string).startsWith("u"),
                "Letter filter"
            )
            const parsedValues = filteredTwiceTable.get("country").values
            expect(parsedValues[0]).toEqual("usa")
            expect(parsedValues[1]).toEqual(undefined)
        })

        it("can filter all", () => {
            const table = new CoreTable(`country,pop
    usa,123
    can,333`)
            const allFiltered = table.rowFilter((row) => false, "filter all")
            expect(allFiltered.get("pop").values).toEqual([])
        })

        it("can filter negatives", () => {
            const table = new CoreTable(`country,pop
    fra,0
    usa,-2
    can,333
    ger,0.1`)
            expect(table.filterNegatives("pop").get("pop").values).toEqual([
                0,
                333,
                0.1,
            ])
        })
    })

    describe("column filter", () => {
        const rootTable = new CoreTable(sampleCsv)
        const filteredTable = rootTable.columnFilter(
            "population",
            (v) => parseInt(v as any) > 40,
            "Pop filter"
        )

        it("can filter", () => {
            expect(rootTable.get("country").values[3]).toEqual("canada")
            const parsedValues = filteredTable.get("country").values
            expect(parsedValues[0]).toEqual("france")
            expect(parsedValues[1]).toEqual("usa")
        })

        it("can chain filters", () => {
            const filteredTwiceTable = filteredTable.columnFilter(
                "country",
                (v) => (v as string).startsWith("u"),
                "Letter filter"
            )
            const parsedValues = filteredTwiceTable.get("country").values
            expect(parsedValues[0]).toEqual("usa")
            expect(parsedValues[1]).toEqual(undefined)
        })

        it("can filter error values", () => {
            const table = new CoreTable(
                [
                    ["country", "value"],
                    ["usa", null],
                    ["usa", "1"],
                ],
                [
                    { slug: "country", type: ColumnTypeNames.String },
                    { slug: "value", type: ColumnTypeNames.Numeric },
                ]
            )
            expect(
                table.columnFilter(
                    "value",
                    (v) => isNotErrorValue(v),
                    "filter out error values"
                ).numRows
            ).toEqual(1)
        })

        it("can filter all", () => {
            const table = new CoreTable(`country,pop
            usa,123
            can,333`)
            const allFiltered = table.columnFilter(
                "pop",
                () => false,
                "filter all"
            )
            expect(allFiltered.get("pop").values).toEqual([])
        })
    })
})

describe("debug tools", () => {
    const table = new CoreTable(sampleCsv).dropColumns(["population"])

    it("can dump its ancestors", () => {
        expect(table.ancestors.length).toEqual(2)
    })
})

describe("printing", () => {
    it("uses slugs for headers in toDelimited", () => {
        const table = new CoreTable(`country,Population in 2020
iceland,1`)
        const csv = table.toDelimited()
        expect(csv).toEqual(`country,Population-in-2020
iceland,1`)
        expect(table.get("country").isEmpty).toBe(false)
    })

    it("can export a clean csv with dates", () => {
        const table = new CoreTable(
            [
                { entityName: "Aruba", day: 1, annotation: "Something, foo" },
                { entityName: "Canada", day: 2 },
            ],
            [
                { slug: "entityName" },
                { slug: "day", type: "Day" as any },
                { slug: "annotation" },
            ]
        )

        expect(table.constantColumns.length).toEqual(0)
        expect(table.toCsvWithColumnNames()).toEqual(`entityName,day,annotation
Aruba,2020-01-22,"Something, foo"
Canada,2020-01-23,`)
    })

    it("can format a value", () => {
        const table = new CoreTable(
            `growthRate
123`,
            [
                {
                    slug: "growthRate",
                    display: { unit: "%" },
                    type: ColumnTypeNames.Numeric,
                },
            ]
        )
        expect(table.get("growthRate").formatValueShort(20)).toEqual("20%")
    })
})

describe("value operations", () => {
    it("can detect all integers", () => {
        const table = new CoreTable(`gdp,perCapita
123,123.1`)
        expect(table.get("gdp").isAllIntegers).toBeTruthy()
        expect(table.get("perCapita").isAllIntegers).toBeFalsy()
    })

    it("can get all defined values for a column", () => {
        const table = new CoreTable(
            [
                { pop: undefined, year: 1999 },
                { pop: 123, year: 2000 },
            ],
            [{ type: ColumnTypeNames.Numeric, slug: "pop" }]
        )
        expect(table.get("pop").numValues).toEqual(1)
        expect(table.get("pop").numErrorValues).toEqual(1)
        expect(table.numColumnsWithErrorValues).toEqual(1)
    })

    it("can replace cells for log scale", () => {
        let table = new CoreTable([
            { pop: -20, gdp: 100, births: -4 },
            { pop: 0, gdp: -2, births: 20 },
        ])
        expect(table.get("pop").numValues).toEqual(2)
        expect(table.get("gdp").numValues).toEqual(2)
        table = table.replaceNonPositiveCellsForLogScale(["pop", "gdp"])
        expect(table.get("pop").numValues).toEqual(0)
        expect(table.get("gdp").numValues).toEqual(1)
        expect(table.get("births").numValues).toEqual(2)
    })
})

describe("joins", () => {
    const leftTable = new CoreTable({
        country: ["usa", "can", "fra"],
        time: [2000, 2001, 2002],
        color: ["red", "green", "red"],
    })
    const rightTable = new CoreTable({
        country: ["usa", "can", "turk"],
        time: [2000, 2001, 2002],
        population: [55, 66, 77],
    })

    it("can create indices", () => {
        const index = leftTable.rowIndex(["color"])
        expect(index.size).toEqual(2)
        const index2 = leftTable.rowIndex(["color", "country"])
        expect(index2.get("red usa")?.length).toEqual(1)
    })

    describe("outer joins", () => {
        it("can left join on all intersecting columns", () => {
            expect(leftTable.leftJoin(rightTable).toTypedMatrix()).toEqual([
                ["country", "time", "color", "population"],
                ["usa", 2000, "red", 55],
                ["can", 2001, "green", 66],
                ["fra", 2002, "red", ErrorValueTypes.NoMatchingValueAfterJoin],
            ])
        })

        it("can left join on one column", () => {
            expect(
                leftTable.leftJoin(rightTable, ["time"]).toTypedMatrix()
            ).toEqual([
                ["country", "time", "color", "population"],
                ["usa", 2000, "red", 55],
                ["can", 2001, "green", 66],
                ["fra", 2002, "red", 77],
            ])
        })

        it("can do a right join", () => {
            expect(leftTable.rightJoin(rightTable).toTypedMatrix()).toEqual([
                ["country", "time", "population", "color"],
                ["usa", 2000, 55, "red"],
                ["can", 2001, 66, "green"],
                ["turk", 2002, 77, ErrorValueTypes.NoMatchingValueAfterJoin],
            ])
        })
    })

    describe("inner joins", () => {
        it("can do a left inner join", () => {
            expect(leftTable.innerJoin(rightTable).toTypedMatrix()).toEqual([
                ["country", "time", "color", "population"],
                ["usa", 2000, "red", 55],
                ["can", 2001, "green", 66],
            ])
        })
    })

    describe("full join", () => {
        it("can do a full join", () => {
            expect(leftTable.fullJoin(rightTable).toTypedMatrix()).toEqual([
                ["country", "time", "color", "population"],
                ["usa", 2000, "red", 55],
                ["can", 2001, "green", 66],
                ["fra", 2002, "red", ErrorValueTypes.NoMatchingValueAfterJoin],
                ["turk", 2002, ErrorValueTypes.NoMatchingValueAfterJoin, 77],
            ])
        })
    })
})

describe("groups", () => {
    const csv = `continent,year,country,gdp
asia,2000,china,900
europe,2001,france,200
asia,2000,japan,300
europe,2000,france,600`

    describe("creating groups", () => {
        const table = new CoreTable(csv)
        const groups = table.groupBy("continent")
        expect(groups.length).toBe(2)
        it("can reduce groups", () => {
            expect(groups[0].reduce({ gdp: "sum" }).firstRow.gdp).toBe(1200)
        })
    })
})
