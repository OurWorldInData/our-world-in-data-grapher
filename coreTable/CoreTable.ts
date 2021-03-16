import {
    formatYear,
    csvEscape,
    min,
    max,
    range,
    difference,
    intersection,
    flatten,
    sum,
    uniqBy,
    intersectionOfSets,
    isNumber,
} from "../clientUtils/Util"
import { isPresent } from "../clientUtils/isPresent"
import { CoreColumn, ColumnTypeMap, MissingColumn } from "./CoreTableColumns"
import {
    ColumnSlug,
    CoreColumnStore,
    CoreRow,
    CoreTableInputOption,
    PrimitiveType,
    Time,
    TransformType,
    ValueRange,
    CoreQuery,
    CoreValueType,
    InputType,
    CoreMatrix,
    TableSlug,
} from "./CoreTableConstants"
import { ColumnTypeNames, CoreColumnDef } from "./CoreColumnDef"
import {
    AlignedTextTableOptions,
    toAlignedTextTable,
    toDelimited,
    toMarkdownTable,
} from "./CoreTablePrinters"
import {
    makeAutoTypeFn,
    columnStoreToRows,
    imemo,
    makeKeyFn,
    makeRowFromColumnStore,
    standardizeSlugs,
    concatColumnStores,
    rowsToColumnStore,
    autodetectColumnDefs,
    reverseColumnStore,
    renameColumnStore,
    replaceRandomCellsInColumnStore,
    getDropIndexes,
    parseDelimited,
    rowsFromMatrix,
    cartesianProduct,
    sortColumnStore,
    emptyColumnsInFirstRowInDelimited,
    truncate,
    replaceCells,
} from "./CoreTableUtils"
import { ErrorValueTypes, isNotErrorValue } from "./ErrorValues"
import { OwidTableSlugs } from "./OwidTableConstants"
import { applyTransforms } from "./Transforms"

interface AdvancedOptions {
    tableDescription?: string
    transformCategory?: TransformType
    parent?: CoreTable
    filterMask?: FilterMask
    tableSlug?: TableSlug
}

// The complex generic with default here just enables you to optionally specify a more
// narrow interface for the input rows. This is helpful for OwidTable.
export class CoreTable<
    ROW_TYPE extends CoreRow = CoreRow,
    COL_DEF_TYPE extends CoreColumnDef = CoreColumnDef
> {
    private _columns: Map<ColumnSlug, CoreColumn> = new Map()
    protected parent?: this
    tableDescription: string
    private timeToLoad = 0
    private initTime = Date.now()

    private originalInput: CoreTableInputOption
    private advancedOptions: AdvancedOptions

    private inputColumnDefs: COL_DEF_TYPE[]
    constructor(
        input: CoreTableInputOption = [],
        inputColumnDefs: COL_DEF_TYPE[] | string = [],
        advancedOptions: AdvancedOptions = {}
    ) {
        const start = Date.now() // Perf aid
        const { parent, tableDescription = "" } = advancedOptions

        this.originalInput = input
        this.tableDescription = tableDescription
        this.parent = parent as this
        this.inputColumnDefs =
            typeof inputColumnDefs === "string"
                ? (columnDefinitionsFromDelimited(
                      inputColumnDefs
                  ) as COL_DEF_TYPE[])
                : inputColumnDefs

        // If any values were passed in, copy those to column store now and then remove them from column definitions.
        // todo: remove values property entirely? may be an anti-pattern.
        this.inputColumnDefs = this.inputColumnDefs.map((def) => {
            if (!def.values) return def
            this.valuesFromColumnDefs[def.slug] = def.values
            const copy = {
                ...def,
            }
            delete copy.values
            return copy
        })

        this.inputColumnDefs.forEach((def) => this.setColumn(def))

        this.advancedOptions = advancedOptions

        // If this has a parent table, than we expect all defs. This makes "deletes" and "renames" fast.
        // If this is the first input table, then we do a simple check to generate any missing column defs.
        if (!parent)
            autodetectColumnDefs(
                this.inputColumnStore,
                this._columns
            ).forEach((def) => this.setColumn(def as COL_DEF_TYPE))

        this.timeToLoad = Date.now() - start // Perf aid
    }

    private valuesFromColumnDefs: CoreColumnStore = {}

    // A method currently used just in debugging but may be useful in the author backend.
    // If your charts look funny, a good thing to check is if the autodetected columns are wrong.
    get autodetectedColumnDefs() {
        const providedSlugs = new Set(
            this.inputColumnDefs.map((def) => def.slug)
        )
        return new CoreTable(
            this.defs.filter((def) => !providedSlugs.has(def.slug))
        )
    }

    @imemo get transformCategory() {
        const { advancedOptions, inputType } = this
        if (advancedOptions.transformCategory)
            return advancedOptions.transformCategory

        if (inputType === InputType.Delimited)
            return TransformType.LoadFromDelimited
        if (inputType === InputType.Matrix) return TransformType.LoadFromMatrix
        if (inputType === InputType.RowStore)
            return TransformType.LoadFromRowStore
        return TransformType.LoadFromColumnStore
    }

    // If the input is a column store, returns that. If it is DSV, parses that and turns it into a column store.
    // If it is a Rows[], turns it into a column store.
    @imemo private get inputColumnStore(): CoreColumnStore {
        const { originalInput, inputType } = this

        if (inputType === InputType.Delimited)
            return this.delimitedAsColumnStore
        else if (inputType === InputType.Matrix)
            return rowsToColumnStore(
                rowsFromMatrix(originalInput as CoreMatrix)
            )
        else if (inputType === InputType.RowStore)
            return rowsToColumnStore(originalInput as CoreRow[])
        return originalInput as CoreColumnStore
    }

    @imemo get columnStore() {
        const {
            inputColumnStore,
            valuesFromColumnDefs,
            inputColumnsToParsedColumnStore,
            inputColumnDefs,
            isRoot,
            advancedOptions,
        } = this

        // Set blank columns
        let columnStore = Object.assign(
            {},
            this.blankColumnStore,
            inputColumnStore,
            valuesFromColumnDefs
        )

        // Overwrite any non-parsed columns with parsed values
        if (Object.keys(inputColumnsToParsedColumnStore).length)
            columnStore = Object.assign(
                columnStore,
                inputColumnsToParsedColumnStore
            )

        // NB: transforms are *only* run on the root table for now. They will not be rerun later on (after adding or filtering rows, for example)
        const columnsFromTransforms = inputColumnDefs.filter(
            (def) => def.transform
        ) // todo: sort by graph dependency order
        if (isRoot && columnsFromTransforms.length)
            columnStore = applyTransforms(columnStore, columnsFromTransforms)

        return advancedOptions.filterMask
            ? advancedOptions.filterMask.apply(columnStore)
            : columnStore
    }

    private get blankColumnStore() {
        const columnsObject: CoreColumnStore = {}
        this.columnSlugs.forEach((slug) => {
            columnsObject[slug] = []
        })
        return columnsObject
    }

    @imemo private get delimitedAsColumnStore() {
        const { originalInput, _numericColumnSlugs } = this
        const parsed = parseDelimited(
            originalInput as string,
            undefined,
            makeAutoTypeFn(_numericColumnSlugs)
        ) as any
        // dsv_parse adds a columns prop to the result we don't want since we handle our own column defs.
        // https://github.com/d3/d3-dsv#dsv_parse
        delete parsed.columns

        const renamedRows = standardizeSlugs(parsed) // todo: pass renamed defs back in.
        return rowsToColumnStore(renamedRows ? renamedRows.rows : parsed)
    }

    get tableSlug() {
        return this.advancedOptions.tableSlug
    }

    private get inputColumnsToParsedColumnStore() {
        const { inputColumnStore, colsToParse } = this
        const columnsObject: CoreColumnStore = {}
        if (!colsToParse.length) return columnsObject
        const missingCols: CoreColumn[] = []
        let len = 0
        colsToParse.forEach((col) => {
            const { slug } = col
            const unparsedVals = inputColumnStore[slug]
            if (!unparsedVals) {
                missingCols.push(col)
                return
            }
            columnsObject[slug] = unparsedVals.map((val) => col.parse(val))
            len = columnsObject[slug].length
        })

        // If column defs were provided but there were no values provided for those columns, create blank columns the same size
        // as the filled columns.
        missingCols.forEach(
            (col) =>
                (columnsObject[col.slug] = range(0, len).map(() =>
                    col.parse(undefined)
                ))
        )
        return columnsObject
    }

    private get colsToParse() {
        const { inputType, columnsAsArray, inputColumnStore } = this
        const firstInputRow = makeRowFromColumnStore(0, inputColumnStore)
        if (inputType === InputType.Delimited) {
            const missingTypes = new Set(
                this.getColumns(
                    emptyColumnsInFirstRowInDelimited(
                        this.originalInput as string
                    )
                )
            ) // Our autotyping is poor if the first value in a column is empty
            return columnsAsArray.filter(
                (col) =>
                    col.needsParsing(firstInputRow[col.slug]) ||
                    missingTypes.has(col)
            )
        }

        if (
            inputType === InputType.ColumnStore ||
            this.parent ||
            !firstInputRow
        )
            return []
        // The default behavior is to assume some missing or bad data in user data, so we always parse the full input the first time we load
        // user data, with the exception of columns that have values passed directly.
        // Todo: measure the perf hit and add a parameter to opt out of this this if you know the data is complete?
        const alreadyTypedSlugs = new Set(
            Object.keys(this.valuesFromColumnDefs)
        )
        if (this.isRoot) {
            return this.columnsAsArray.filter(
                (col) => !alreadyTypedSlugs.has(col.slug)
            )
        }

        return columnsAsArray.filter(
            (col) =>
                !alreadyTypedSlugs.has(col.slug) ||
                col.needsParsing(firstInputRow[col.slug])
        )
    }

    toOneDimensionalArray() {
        return flatten(this.toTypedMatrix().slice(1))
    }

    private setColumn(def: COL_DEF_TYPE) {
        const { type, slug } = def
        const ColumnType = (type && ColumnTypeMap[type]) || ColumnTypeMap.String
        this._columns.set(slug, new ColumnType(this, def))
    }

    protected transform(
        rowsOrColumnStore: ROW_TYPE[] | CoreColumnStore | CoreMatrix,
        defs: COL_DEF_TYPE[],
        tableDescription: string,
        transformCategory: TransformType,
        filterMask?: FilterMask
    ): this {
        // The combo of the "this" return type and then casting this to any allows subclasses to create transforms of the
        // same type. The "any" typing is very brief (the returned type will have the same type as the instance being transformed).
        return new (this.constructor as any)(rowsOrColumnStore, defs, {
            parent: this,
            tableDescription,
            transformCategory,
            filterMask,
        } as AdvancedOptions)
    }

    // Time between when the parent table finished loading and this table started constructing.
    // A large time may just be due to a transform only happening after a user action, or it
    // could be do to other sync code executing between transforms.
    private get betweenTime(): number {
        return this.parent
            ? this.initTime - (this.parent.initTime + this.parent.timeToLoad)
            : 0
    }

    @imemo get rows() {
        return columnStoreToRows(this.columnStore) as ROW_TYPE[]
    }

    @imemo get indices() {
        return range(0, this.numRows)
    }

    *[Symbol.iterator]() {
        const { columnStore, numRows } = this
        for (let index = 0; index < numRows; index++) {
            yield makeRowFromColumnStore(index, columnStore)
        }
    }

    getTimesAtIndices(indices: number[]) {
        if (!indices.length) return []
        return this.getValuesAtIndices(this.timeColumn!.slug, indices) as Time[]
    }

    getValuesAtIndices(columnSlug: ColumnSlug, indices: number[]) {
        const values = this.get(columnSlug).valuesIncludingErrorValues
        return indices.map((index) => values[index])
    }

    @imemo get firstRow() {
        return makeRowFromColumnStore(0, this.columnStore) as ROW_TYPE
    }

    @imemo get lastRow() {
        return makeRowFromColumnStore(
            this.numRows - 1,
            this.columnStore
        ) as ROW_TYPE
    }

    @imemo get numRows() {
        const firstColValues = Object.values(this.columnStore)[0]
        return firstColValues ? firstColValues.length : 0
    }

    @imemo get numColumns() {
        return this.columnSlugs.length
    }

    get(columnSlug: ColumnSlug | undefined): CoreColumn {
        if (columnSlug === undefined)
            return new MissingColumn(this, {
                slug: `undefined_slug`,
            })
        return (
            this._columns.get(columnSlug) ??
            new MissingColumn(this, {
                slug: columnSlug,
            })
        )
    }

    has(columnSlug: ColumnSlug | undefined) {
        if (columnSlug === undefined) return false
        return this._columns.has(columnSlug)
    }

    getFirstColumnWithType(columnTypeName: ColumnTypeNames) {
        return this.columnsAsArray.find(
            (col) => col.def.type === columnTypeName
        )
    }

    // todo: move this. time methods should not be in CoreTable, in OwidTable instead (which is really TimeSeriesTable).
    // TODO: remove this. Currently we use this to get the right day/year time formatting. For now a chart is either a "day chart" or a "year chart".
    // But we can have charts with multiple time columns. Ideally each place that needs access to the timeColumn, would get the specific column
    // and not the first time column from the table.
    @imemo get timeColumn() {
        // For now, return a day column first if present. But see note above about removing this method.
        return (
            this.columnsAsArray.find(
                (col) => col instanceof ColumnTypeMap.Day
            ) ??
            this.columnsAsArray.find(
                (col) => col instanceof ColumnTypeMap.Date
            ) ??
            this.columnsAsArray.find(
                (col) => col instanceof ColumnTypeMap.Year
            ) ??
            this.columnsAsArray.find(
                (col) => col instanceof ColumnTypeMap.Quarter
            ) ??
            this.get(OwidTableSlugs.time)
        )
    }

    // todo: should be on owidtable
    @imemo get entityNameColumn() {
        return (
            this.getFirstColumnWithType(ColumnTypeNames.EntityName) ??
            this.get(OwidTableSlugs.entityName)
        )
    }

    // todo: should be on owidtable
    @imemo get entityNameSlug() {
        return this.entityNameColumn.slug
    }

    // Todo: remove this. Generally this should not be called until the data is loaded. Even then, all calls should probably be made
    // on the column itself, and not tied tightly to the idea of a time column.
    @imemo get timeColumnFormatFunction() {
        return !this.timeColumn.isMissing
            ? this.timeColumn.formatValue
            : formatYear
    }

    formatTime(value: any) {
        return this.timeColumnFormatFunction(value)
    }

    @imemo private get columnsWithParseErrors() {
        return this.columnsAsArray.filter((col) => col.numErrorValues)
    }

    @imemo get numColumnsWithErrorValues() {
        return this.columnsWithParseErrors.length
    }

    @imemo get numErrorValues() {
        return sum(this.columnsAsArray.map((col) => col.numErrorValues))
    }

    @imemo get numValidCells() {
        return sum(this.columnsAsArray.map((col) => col.numValues))
    }

    get rootTable(): this {
        return this.parent ? this.parent.rootTable : this
    }

    /**
     * Returns a string map (aka index) where the keys are the combined string values of columnSlug[], and the values
     * are the indices for the rows that match.
     *
     * {country: "USA", population: 100}
     *
     * So `table.rowIndex(["country", "population"]).get("USA 100")` would return [0].
     *
     */
    rowIndex(columnSlugs: ColumnSlug[]) {
        const index = new Map<string, number[]>()
        const keyFn = makeKeyFn(this.columnStore, columnSlugs)
        this.indices.forEach((rowIndex) => {
            // todo: be smarter for string keys
            const key = keyFn(rowIndex)
            if (!index.has(key)) index.set(key, [])
            index.get(key)!.push(rowIndex)
        })
        return index
    }

    /**
     * Returns a map (aka index) where the keys are the values of the indexColumnSlug, and the values
     * are the values of the valueColumnSlug.
     *
     * {country: "USA", population: 100}
     *
     * So `table.valueIndex("country", "population").get("USA")` would return 100.
     *
     */
    protected valueIndex(
        indexColumnSlug: ColumnSlug,
        valueColumnSlug: ColumnSlug
    ) {
        const indexCol = this.get(indexColumnSlug)
        const valueCol = this.get(valueColumnSlug)
        const indexValues = indexCol.valuesIncludingErrorValues
        const valueValues = valueCol.valuesIncludingErrorValues
        const valueIndices = new Set(valueCol.validRowIndices)
        const intersection = indexCol.validRowIndices.filter((index) =>
            valueIndices.has(index)
        )

        const map = new Map<PrimitiveType, PrimitiveType>()
        intersection.forEach((index) => {
            map.set(
                indexValues[index] as PrimitiveType,
                valueValues[index] as PrimitiveType
            )
        })
        return map
    }

    grep(searchStringOrRegex: string | RegExp) {
        return this.rowFilter((row) => {
            const line = Object.values(row).join(" ")
            return typeof searchStringOrRegex === "string"
                ? line.includes(searchStringOrRegex)
                : searchStringOrRegex.test(line)
        }, `Kept rows that matched '${searchStringOrRegex.toString()}'`)
    }

    get opposite() {
        const { parent } = this
        const { filterMask } = this.advancedOptions
        if (!filterMask || !parent) return this
        return this.transform(
            parent.columnStore,
            this.defs,
            `Inversing previous filter`,
            TransformType.InverseFilterRows,
            filterMask.inverse()
        )
    }

    @imemo get oppositeColumns() {
        if (this.isRoot) return this
        const columnsToDrop = new Set(this.columnSlugs)
        const defs = this.parent!.columnsAsArray.filter(
            (col) => !columnsToDrop.has(col.slug)
        ).map((col) => col.def) as COL_DEF_TYPE[]
        return this.transform(
            this.columnStore,
            defs,
            `Inversing previous column filter`,
            TransformType.InverseFilterColumns
        )
    }

    grepColumns(searchStringOrRegex: string | RegExp) {
        const columnsToDrop = this.columnSlugs.filter((slug) => {
            return typeof searchStringOrRegex === "string"
                ? !slug.includes(searchStringOrRegex)
                : !searchStringOrRegex.test(slug)
        })

        return this.dropColumns(
            columnsToDrop,
            `Kept ${
                this.columnSlugs.length - columnsToDrop.length
            } columns that matched '${searchStringOrRegex.toString()}'.`
        )
    }

    rowFilter(
        predicate: (row: ROW_TYPE, index: number) => boolean,
        opName: string
    ) {
        return this.transform(
            this.columnStore,
            this.defs,
            opName,
            TransformType.FilterRows,
            new FilterMask(this.numRows, this.rows.map(predicate)) // Warning: this will be slow
        )
    }

    columnFilter(
        columnSlug: ColumnSlug,
        predicate: (value: CoreValueType, index: number) => boolean,
        opName: string
    ) {
        return this.transform(
            this.columnStore,
            this.defs,
            opName,
            TransformType.FilterRows,
            new FilterMask(
                this.numRows,
                this.get(columnSlug).valuesIncludingErrorValues.map(predicate)
            )
        )
    }

    sortBy(slugs: ColumnSlug[]) {
        return this.transform(
            sortColumnStore(this.columnStore, slugs),
            this.defs,
            `Sort by ${slugs.join(",")}`,
            TransformType.SortRows
        )
    }

    sortColumns(slugs: ColumnSlug[]) {
        const first = this.getColumns(slugs)
        const rest = this.columnsAsArray.filter((col) => !first.includes(col))
        return this.transform(
            this.columnStore,
            [...first, ...rest].map((col) => col.def as COL_DEF_TYPE),
            `Sorted columns`,
            TransformType.SortColumns
        )
    }

    reverse() {
        return this.transform(
            reverseColumnStore(this.columnStore),
            this.defs,
            `Reversed row order`,
            TransformType.SortRows
        )
    }

    // Assumes table is sorted by columnSlug. Returns an array representing the starting index of each new group.
    protected groupBoundaries(columnSlug: ColumnSlug) {
        const values = this.get(columnSlug).valuesIncludingErrorValues
        const arr: number[] = []
        let last: CoreValueType
        this.get(columnSlug).valuesIncludingErrorValues.forEach(
            (val, index) => {
                if (val !== last) {
                    arr.push(index)
                    last = val
                }
            }
        )
        // Include the end of the last group, which doesn't result in a change in value above.
        if (values && values.length) {
            arr.push(values.length)
        }
        return arr
    }

    @imemo get defs() {
        return this.columnsAsArray.map((col) => col.def) as COL_DEF_TYPE[]
    }

    @imemo get columnNames() {
        return this.columnsAsArray.map((col) => col.name)
    }

    @imemo get columnTypes() {
        return this.columnsAsArray.map((col) => col.def.type)
    }

    @imemo get columnJsTypes() {
        return this.columnsAsArray.map((col) => col.jsType)
    }

    @imemo get columnSlugs() {
        return Array.from(this._columns.keys())
    }

    @imemo get numericColumnSlugs() {
        return this._numericColumnSlugs
    }

    private get _numericColumnSlugs() {
        return this._columnsAsArray
            .filter((col) => col instanceof ColumnTypeMap.Numeric)
            .map((col) => col.slug)
    }

    private get _columnsAsArray() {
        return Array.from(this._columns.values())
    }

    @imemo get columnsAsArray() {
        return this._columnsAsArray
    }

    getColumns(slugs: ColumnSlug[]) {
        return slugs.map((slug) => this.get(slug))
    }

    // Get the min and max for multiple columns at once
    domainFor(slugs: ColumnSlug[]): ValueRange {
        const cols = this.getColumns(slugs)
        const mins = cols.map((col) => col.minValue)
        const maxes = cols.map((col) => col.maxValue)
        return [min(mins), max(maxes)]
    }

    private extract(slugs = this.columnSlugs) {
        return this.rows.map((row) =>
            slugs.map((slug) =>
                isNotErrorValue(row[slug]) ? row[slug] : undefined
            )
        )
    }

    private get isRoot() {
        return !this.parent
    }

    dump(rowLimit = 30) {
        this.dumpPipeline()
        this.dumpColumns()
        this.dumpRows(rowLimit)
    }

    dumpPipeline() {
        // eslint-disable-next-line no-console
        console.table(this.ancestors.map((tb) => tb.explanation))
    }

    dumpColumns() {
        // eslint-disable-next-line no-console
        console.table(this.explainColumns)
    }

    rowsFrom(start: number, end: number) {
        if (start >= this.numRows) return []
        if (end > this.numRows) end = this.numRows
        return range(start, end).map((index) =>
            makeRowFromColumnStore(index, this.columnStore)
        )
    }

    dumpRows(rowLimit = 30) {
        // eslint-disable-next-line no-console
        console.table(this.rowsFrom(0, rowLimit), this.columnSlugs)
    }

    dumpInputTable() {
        // eslint-disable-next-line no-console
        console.table(this.inputAsTable)
    }

    @imemo private get inputType() {
        const { originalInput } = this
        if (typeof originalInput === "string") return InputType.Delimited
        if (Array.isArray(originalInput))
            return Array.isArray(originalInput[0])
                ? InputType.Matrix
                : InputType.RowStore
        return InputType.ColumnStore
    }

    @imemo private get inputColumnStoreToRows() {
        return columnStoreToRows(this.inputColumnStore)
    }

    @imemo private get inputAsTable() {
        const { inputType } = this
        return inputType === InputType.ColumnStore
            ? this.inputColumnStoreToRows
            : inputType === InputType.Matrix
            ? rowsFromMatrix(this.originalInput as CoreMatrix)
            : this.originalInput
    }

    @imemo private get explainColumns() {
        return this.columnsAsArray.map((col) => {
            const {
                slug,
                jsType,
                name,
                numValues,
                numErrorValues,
                displayName,
                def,
            } = col
            return {
                slug,
                type: def.type,
                jsType,
                name,
                numValues,
                numErrorValues,
                displayName,
                color: def.color,
            }
        })
    }

    get ancestors(): this[] {
        return this.parent ? [...this.parent.ancestors, this] : [this]
    }

    @imemo private get numColsToParse() {
        return this.colsToParse.length
    }

    private static guids = 0
    private guid = ++CoreTable.guids

    private get explanation() {
        // todo: is there a better way to do this in JS?
        const {
            tableDescription,
            transformCategory,
            guid,
            numColumns,
            numRows,
            betweenTime,
            timeToLoad,
            numColsToParse,
            numValidCells,
            numErrorValues,
            numColumnsWithErrorValues,
        } = this
        return {
            tableDescription: truncate(tableDescription, 40),
            transformCategory,
            guid,
            numColumns,
            numRows,
            betweenTime,
            timeToLoad,
            numColsToParse,
            numValidCells,
            numErrorValues,
            numColumnsWithErrorValues,
        }
    }

    // Output a pretty table for consles
    toAlignedTextTable(options?: AlignedTextTableOptions) {
        return toAlignedTextTable(this.columnSlugs, this.rows, options)
    }

    toMarkdownTable() {
        return toMarkdownTable(this.columnSlugs, this.rows)
    }

    toDelimited(
        delimiter: string = ",",
        columnSlugs = this.columnSlugs,
        rows = this.rows
    ) {
        return toDelimited(delimiter, columnSlugs, rows)
    }

    toTsv() {
        return this.toDelimited("\t")
    }

    toCsvWithColumnNames() {
        const delimiter = ","
        const header =
            this.columnsAsArray
                .map((col) => csvEscape(col.name))
                .join(delimiter) + "\n"
        const body = this.rows
            .map((row) =>
                this.columnsAsArray.map(
                    (col) => col.formatForCsv(row[col.slug]) ?? ""
                )
            )
            .map((row) => row.join(delimiter))
            .join("\n")
        return header + body
    }

    // Get all the columns that only have 1 value
    get constantColumns() {
        return this.columnsAsArray.filter((col) => col.isConstant)
    }

    rowsAt(indices: number[]): ROW_TYPE[] {
        const { columnStore } = this
        return indices.map(
            (index) => makeRowFromColumnStore(index, columnStore) as ROW_TYPE
        )
    }

    findRows(query: CoreQuery) {
        return this.rowsAt(this.findRowsIndices(query))
    }

    findRowsIndices(query: CoreQuery) {
        const slugs = Object.keys(query)
        if (!slugs.length) return this.indices
        const arrs = this.getColumns(slugs).map((col) =>
            col.indicesWhere(query[col.slug])
        )
        return intersection(...arrs)
    }

    indexOf(row: ROW_TYPE) {
        return this.findRowsIndices(row)[0] ?? -1
    }

    where(query: CoreQuery) {
        const rows = this.findRows(query)
        const queryDescription = Object.entries(query)
            .map(([col, value]) => `${col}=${value}`)
            .join("&")

        return this.transform(
            rows,
            this.defs,
            `Selecting ${rows.length} rows where ${queryDescription}`,
            TransformType.FilterRows
        )
    }

    appendRows(rows: ROW_TYPE[], opDescription: string) {
        return this.concat(
            [new (this.constructor as any)(rows, this.defs) as CoreTable],
            opDescription
        )
    }

    limit(howMany: number, offset: number = 0) {
        const start = offset
        const end = offset + howMany
        return this.transform(
            this.columnStore,
            this.defs,
            `Kept ${howMany} rows starting at ${offset}`,
            TransformType.FilterRows,
            new FilterMask(
                this.numRows,
                this.indices.map((index) => index >= start && index < end)
            )
        )
    }

    updateDefs(fn: (def: COL_DEF_TYPE) => COL_DEF_TYPE) {
        return this.transform(
            this.columnStore,
            this.defs.map(fn),
            `Updated column defs`,
            TransformType.UpdateColumnDefs
        )
    }

    limitColumns(howMany: number, offset: number = 0) {
        const slugs = this.columnSlugs.slice(offset, howMany + offset)
        return this.dropColumns(
            slugs,
            `Kept ${howMany} columns and dropped '${slugs}'`
        )
    }

    select(slugs: ColumnSlug[]) {
        const columnsToKeep = new Set(slugs)
        const defs = this.columnsAsArray
            .filter((col) => columnsToKeep.has(col.slug))
            .map((col) => col.def) as COL_DEF_TYPE[]
        return this.transform(
            this.columnStore,
            defs,
            `Kept columns '${slugs}'`,
            TransformType.FilterColumns
        )
    }

    keepOnlyColumns(slugs: ColumnSlug[]) {
        const columnsToKeep = new Set(slugs)
        const newStore = {
            ...this.columnStore,
        }
        const defs = this.columnsAsArray
            .filter((col) => columnsToKeep.has(col.slug))
            .map((col) => col.def) as COL_DEF_TYPE[]
        Object.keys(newStore).forEach((slug) => {
            if (!columnsToKeep.has(slug)) delete newStore[slug]
        })
        return this.transform(
            newStore,
            defs,
            `Kept only columns '${slugs}'`,
            TransformType.FilterColumns
        )
    }

    dropColumns(slugs: ColumnSlug[], message?: string) {
        const columnsToDrop = new Set(slugs)
        const newStore = {
            ...this.columnStore,
        }
        const defs = this.columnsAsArray
            .filter((col) => !columnsToDrop.has(col.slug))
            .map((col) => col.def) as COL_DEF_TYPE[]
        slugs.forEach((slug) => {
            delete newStore[slug]
        })
        return this.transform(
            newStore,
            defs,
            message ?? `Dropped columns '${slugs}'`,
            TransformType.FilterColumns
        )
    }

    @imemo get duplicateRowIndices() {
        const keyFn = makeKeyFn(this.columnStore, this.columnSlugs)
        const dupeSet = new Set()
        const dupeIndices: number[] = []
        this.indices.forEach((rowIndex) => {
            const key = keyFn(rowIndex)
            if (dupeSet.has(key)) dupeIndices.push(rowIndex)
            else dupeSet.add(key)
        })
        return dupeIndices
    }

    dropDuplicateRows() {
        return this.dropRowsAt(this.duplicateRowIndices)
    }

    isRowEmpty(index: number) {
        const { columnStore } = this
        return (
            this.columnSlugs
                .map((slug) => columnStore[slug][index])
                .filter((value) => isNotErrorValue(value) && value !== "")
                .length === 0
        )
    }

    dropEmptyRows() {
        return this.dropRowsAt(
            this.indices
                .map((index) => (this.isRowEmpty(index) ? index : null))
                .filter(isPresent)
        )
    }

    renameColumn(oldSlug: ColumnSlug, newSlug: ColumnSlug) {
        return this.renameColumns({ [oldSlug]: newSlug })
    }

    // Todo: improve typings. After renaming a column the row interface should change. Applies to some other methods as well.
    renameColumns(columnRenameMap: { [columnSlug: string]: ColumnSlug }) {
        const oldSlugs = Object.keys(columnRenameMap)
        const newSlugs = Object.values(columnRenameMap)

        const message =
            `Renamed ` +
            oldSlugs
                .map((name, index) => `'${name}' to '${newSlugs[index]}'`)
                .join(" and ")

        return this.transform(
            renameColumnStore(this.columnStore, columnRenameMap),
            this.defs.map((def) =>
                oldSlugs.indexOf(def.slug) > -1
                    ? {
                          ...def,
                          slug: newSlugs[oldSlugs.indexOf(def.slug)],
                      }
                    : def
            ),
            message,
            TransformType.RenameColumns
        )
    }

    dropRowsAt(indices: number[], message?: string) {
        return this.transform(
            this.columnStore,
            this.defs,
            message ?? `Dropping ${indices.length} rows`,
            TransformType.FilterRows,
            new FilterMask(this.numRows, indices, false)
        )
    }

    // for testing. Preserves ordering.
    dropRandomRows(howMany = 1, seed = Date.now()) {
        if (!howMany) return this // todo: clone?
        const indexesToDrop = getDropIndexes(this.numRows, howMany, seed)
        return this.dropRowsAt(
            Array.from(indexesToDrop.values()),
            `Dropping a random ${howMany} rows`
        )
    }

    replaceNonPositiveCellsForLogScale(columnSlugs: ColumnSlug[] = []) {
        return this.transform(
            replaceCells(this.columnStore, columnSlugs, (val) =>
                val <= 0 ? ErrorValueTypes.InvalidOnALogScale : val
            ),
            this.defs,
            `Replaced negative or zero cells across columns ${columnSlugs.join(
                " and "
            )}`,
            TransformType.UpdateRows
        )
    }

    replaceNonNumericCellsWithErrorValues(columnSlugs: ColumnSlug[]) {
        return this.transform(
            replaceCells(this.columnStore, columnSlugs, (val) =>
                !isNumber(val) ? ErrorValueTypes.NaNButShouldBeNumber : val
            ),
            this.defs,
            `Replaced non-numeric cells across columns ${columnSlugs.join(
                ", "
            )}`,
            TransformType.UpdateRows
        )
    }

    replaceRandomCells(
        howMany = 1,
        columnSlugs: ColumnSlug[] = [],
        seed = Date.now(),
        replacementGenerator: () => any = () =>
            ErrorValueTypes.DroppedForTesting
    ) {
        return this.transform(
            replaceRandomCellsInColumnStore(
                this.columnStore,
                howMany,
                columnSlugs,
                seed,
                replacementGenerator
            ),
            this.defs,
            `Replaced a random ${howMany} cells in ${columnSlugs.join(
                " and "
            )}`,
            TransformType.UpdateRows
        )
    }

    dropRandomPercent(dropHowMuch = 1, seed = Date.now()) {
        return this.dropRandomRows(
            Math.floor((dropHowMuch / 100) * this.numRows),
            seed
        )
    }

    isGreaterThan(
        columnSlug: ColumnSlug,
        value: PrimitiveType,
        opName?: string
    ) {
        return this.columnFilter(
            columnSlug,
            (colValue) => colValue > value,
            opName ?? `Filter where ${columnSlug} > ${value}`
        )
    }

    filterNegativesForLogScale(columnSlug: ColumnSlug) {
        return this.isGreaterThan(
            columnSlug,
            0,
            `Remove rows if ${columnSlug} is <= 0 for log scale`
        )
    }

    filterNegatives(slug: ColumnSlug) {
        return this.columnFilter(
            slug,
            (value) => value >= 0,
            `Filter negative values for ${slug}`
        )
    }

    appendColumns(defs: COL_DEF_TYPE[]) {
        return this.transform(
            this.columnStore,
            this.defs.concat(defs),
            `Appended columns ${defs
                .map((def) => `'${def.slug}'`)
                .join(" and ")}`,
            TransformType.AppendColumns
        )
    }

    duplicateColumn(slug: ColumnSlug, overrides: COL_DEF_TYPE) {
        return this.transform(
            {
                ...this.columnStore,
                [overrides.slug]: this.columnStore[slug],
            },
            this.defs.concat([
                {
                    ...this.get(slug).def,
                    ...overrides,
                },
            ]),
            `Duplicated column '${slug}' to column '${overrides.slug}'`,
            TransformType.AppendColumns
        )
    }

    transpose(
        by: ColumnSlug,
        columnTypeNameForNewColumns = ColumnTypeNames.Numeric
    ) {
        const newColumnSlugs = [by, ...this.get(by).uniqValues]
        const newColumnDefs = newColumnSlugs.map((slug) => {
            if (slug === by) return { slug }
            return {
                type: columnTypeNameForNewColumns,
                slug,
            }
        }) as COL_DEF_TYPE[]
        const newRowValues = this.columnsAsArray
            .filter((col) => col.slug !== by)
            .map((col) => [col.slug, ...col.valuesIncludingErrorValues])
        return this.transform(
            [newColumnSlugs, ...newRowValues],
            newColumnDefs,
            `Transposed`,
            TransformType.Transpose
        )
    }

    columnIntersection(tables: CoreTable[]) {
        return intersection(
            this.columnSlugs,
            ...tables.map((table) => table.columnSlugs)
        )
    }

    private intersectingRowIndices(tables: CoreTable[]) {
        const columnSlugs = this.columnIntersection(tables)
        if (!columnSlugs.length) return []
        const thisIndex = this.rowIndex(columnSlugs)
        const indices = [
            thisIndex,
            ...tables.map((table) => table.rowIndex(columnSlugs)),
        ]
        const keys = intersectionOfSets(
            indices.map((index) => new Set(index.keys()))
        )
        return Array.from(keys).map((key) => thisIndex.get(key)![0]) // Only include first match if many b/c we are treating tables as sets here
    }

    intersection(tables: CoreTable[]) {
        return this.transform(
            this.columnStore,
            this.defs,
            `Keeping only rows also in all tables`,
            TransformType.FilterRows,
            new FilterMask(
                this.numRows,
                this.intersectingRowIndices(tables),
                true
            )
        )
    }

    difference(tables: CoreTable[]) {
        return this.transform(
            this.columnStore,
            this.defs,
            `Keeping only rows not in all other tables`,
            TransformType.FilterRows,
            new FilterMask(
                this.numRows,
                this.intersectingRowIndices(tables),
                false
            )
        )
    }

    appendColumnsIfNew(defs: COL_DEF_TYPE[]) {
        return this.appendColumns(defs.filter((def) => !this.has(def.slug)))
    }

    toMatrix() {
        const slugs = this.columnSlugs
        const rows = this.rows.map((row) =>
            slugs.map((slug) =>
                isNotErrorValue(row[slug]) ? row[slug] : undefined
            )
        )
        return [this.columnSlugs, ...rows]
    }

    // Same as toMatrix, but preserves error types
    toTypedMatrix() {
        const slugs = this.columnSlugs
        const rows = this.rows.map((row) => slugs.map((slug) => row[slug]))
        return [this.columnSlugs, ...rows]
    }

    defToObject() {
        const output: any = {}
        this.columnsAsArray.forEach((col) => {
            output[col.slug] = col.def
        })
        return output
    }

    toJs() {
        return {
            columns: this.defToObject(),
            rows: this.rows,
        }
    }

    private join(
        destinationTable: CoreTable,
        sourceTable: CoreTable,
        by?: ColumnSlug[]
    ) {
        by =
            by ??
            intersection(sourceTable.columnSlugs, destinationTable.columnSlugs)
        const columnSlugsToAdd = difference(
            sourceTable.columnSlugs,
            destinationTable.columnSlugs
        )
        const defsToAdd = sourceTable
            .getColumns(columnSlugsToAdd)
            .map((col) => {
                const def = { ...col.def }
                def.values = []
                return def
            }) as COL_DEF_TYPE[]

        const rightIndex = sourceTable.rowIndex(by)
        const sourceColumns = sourceTable.columnStore
        const keyFn = makeKeyFn(destinationTable.columnStore, by)

        destinationTable.indices.forEach((rowIndex) => {
            const matchingRightRowIndex = rightIndex.get(keyFn(rowIndex))
            defsToAdd.forEach((def) => {
                if (matchingRightRowIndex !== undefined)
                    def.values?.push(
                        sourceColumns[def.slug][matchingRightRowIndex[0]]
                    )
                // todo: use first or last match?
                else
                    def.values?.push(
                        ErrorValueTypes.NoMatchingValueAfterJoin as any
                    )
            })
        })
        return defsToAdd
    }

    concat(tables: CoreTable[], message = `Combined tables`) {
        const all = [this, ...tables] as CoreTable[]
        const defs = flatten(all.map((table) => table.defs)) as COL_DEF_TYPE[]
        const uniqDefs = uniqBy(defs, (def) => def.slug)
        return this.transform(
            concatColumnStores(
                all.map((table) => table.columnStore),
                uniqDefs.map((def) => def.slug)
            ),
            uniqDefs,
            message,
            TransformType.Concat
        )
    }

    complete(columnSlugs: ColumnSlug[]): this {
        const index = this.rowIndex(columnSlugs)
        const cols = this.getColumns(columnSlugs)
        const product = cartesianProduct(...cols.map((col) => col.uniqValues))
        const toAdd = product.filter((row) => !index.has(row.join(" ")))
        return this.appendRows(
            rowsFromMatrix([columnSlugs, ...toAdd]),
            `Append missing combos of ${columnSlugs}`
        )
    }

    leftJoin(rightTable: CoreTable, by?: ColumnSlug[]): this {
        return this.appendColumns(this.join(this, rightTable, by))
    }

    rightJoin(rightTable: CoreTable, by?: ColumnSlug[]): this {
        return rightTable.leftJoin(this, by) as any // todo: change parent?
    }

    innerJoin(rightTable: CoreTable, by?: ColumnSlug[]) {
        const defs = this.join(this, rightTable, by)
        const newValues = defs.map((def) => def.values)
        const rowsToDrop: number[] = []
        newValues.forEach((col) => {
            col?.forEach((value, index) => {
                if ((value as any) === ErrorValueTypes.NoMatchingValueAfterJoin)
                    rowsToDrop.push(index)
            })
        })
        return this.appendColumns(defs).dropRowsAt(rowsToDrop)
    }

    fullJoin(rightTable: CoreTable, by?: ColumnSlug[]): this {
        return this.leftJoin(rightTable, by)
            .concat([rightTable.leftJoin(this, by)])
            .dropDuplicateRows()
    }

    union(tables: CoreTable[]) {
        return this.concat(tables).dropDuplicateRows()
    }

    indexBy(slug: ColumnSlug) {
        const map = new Map<CoreValueType, number[]>()
        this.get(slug).values.map((value, index) => {
            if (!map.has(value)) map.set(value, [])
            map.get(value)!.push(index)
        })
        return map
    }

    groupBy(by: ColumnSlug) {
        const index = this.indexBy(by)
        return Array.from(index.keys()).map((groupName) =>
            this.transform(
                this.columnStore,
                this.defs,
                `Rows for group ${groupName}`,
                TransformType.FilterRows,
                new FilterMask(this.numRows, index.get(groupName)!)
            )
        )
    }

    reduce(reductionMap: ReductionMap) {
        const lastRow = { ...this.lastRow }
        Object.keys(reductionMap).forEach((slug: keyof ROW_TYPE) => {
            const prop = reductionMap[slug]
            const col = this.get(slug)
            if (typeof prop === "string") lastRow[slug] = col[prop]
            else lastRow[slug] = prop(col) as any
        })
        return this.transform(
            rowsToColumnStore([lastRow]),
            this.defs,
            `Reduced table`,
            TransformType.Reduce
        )
    }
}

interface ReductionMap {
    [columnSlug: string]:
        | ReductionTypes
        | ((column: CoreColumn) => CoreValueType)
}

type ReductionTypes = keyof CoreColumn

class FilterMask {
    private mask: boolean[]
    private numRows: number
    constructor(
        numRows: number,
        input: boolean[] | number[],
        keepThese = true
    ) {
        this.numRows = numRows
        if (typeof input[0] === "boolean") this.mask = input as boolean[]
        else {
            const set = new Set(input as number[])
            this.mask = range(0, numRows).map((index) =>
                set.has(index) ? keepThese : !keepThese
            )
        }
    }

    inverse() {
        return new FilterMask(
            this.numRows,
            this.mask.map((bit) => !bit)
        )
    }

    apply(columnStore: CoreColumnStore) {
        console.log(
            "filter.",
            "old rows:",
            this.numRows,
            "new rows:",
            this.mask.reduce((p, c) => p + (c ? 1 : 0), 0),
            "columns:",
            Object.keys(columnStore).length
        )
        console.time("filter")
        const columnsObject: CoreColumnStore = {}
        Object.keys(columnStore).forEach((slug) => {
            columnsObject[slug] = columnStore[slug].filter(
                (slug, index) => this.mask[index]
            )
        })
        console.timeEnd("filter")
        return columnsObject
    }
}

/**
 * Allows you to store your column definitions in CSV/TSV like:
 * slug,name,type etc.
 *
 * todo: define all column def property types
 */
const columnDefinitionsFromDelimited = (delimited: string) =>
    new CoreTable(delimited.trim()).columnFilter(
        "slug",
        (value) => !!value,
        "Keep only column defs with a slug"
    ).rows
