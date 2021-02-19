import { omit } from "../../clientUtils/Util"
import {
    QueryParams,
    queryParamsToStr,
    RawQueryParams,
    rawQueryParamsToQueryParams,
    strToQueryParams,
} from "../../clientUtils/url"
import { patchFromQueryParams } from "./ExplorerUrlMigrationUtils"
import { ExplorerUrlMigrationSpec } from "./ExplorerUrlMigrations"
import { legacyToCurrentGrapherUrl } from "../../grapher/core/GrapherUrlMigrations"
import { Url } from "../../urls/Url"
import { EXPLORERS_ROUTE_FOLDER } from "../ExplorerConstants"

const legacyIntervalToNewValue = {
    daily: "New per day",
    weekly: "Weekly",
    total: "Cumulative",
    smoothed: "7-day rolling average",
    biweekly: "Biweekly",
    weeklyChange: "Weekly change",
    biweeklyChange: "Biweekly change",
}

const covidMetricFromLegacyQueryParams = (queryParams: QueryParams) => {
    if (queryParams.casesMetric) {
        return "Confirmed cases"
    } else if (queryParams.deathsMetric) {
        return "Confirmed deaths"
    } else if (queryParams.cfrMetric) {
        return "Case fatality rate"
    } else if (queryParams.testsMetric) {
        return "Tests"
    } else if (queryParams.testsPerCaseMetric) {
        return "Tests per confirmed case"
    } else if (queryParams.positiveTestRate) {
        return "Share of positive tests"
    } else if (queryParams.vaccinationsMetric) {
        return "Vaccinations"
    }
    return undefined
}

const covidIntervalFromLegacyQueryParams = (queryParams: QueryParams) => {
    let legacyInterval: string | undefined = undefined

    // Early on, the query string was a few booleans like dailyFreq=true.
    // Now it is a single 'interval'. This transformation is for backward compat.
    if (queryParams.interval) {
        legacyInterval = queryParams.interval.decoded
    } else if (queryParams.totalFreq) {
        legacyInterval = "total"
    } else if (queryParams.dailyFreq) {
        legacyInterval = "daily"
    } else if (queryParams.smoothing) {
        legacyInterval = "smoothed"
    }

    if (legacyInterval) {
        return legacyIntervalToNewValue[
            legacyInterval as keyof typeof legacyIntervalToNewValue
        ]
    }

    return undefined
}

const legacyToCurrentCovidQueryParams = (
    queryStr: string,
    baseQueryStr?: string
): RawQueryParams => {
    const queryParams = strToQueryParams(queryStr)
    const baseQueryParams = strToQueryParams(baseQueryStr)

    const { aligned, perCapita, ...restQueryParams } = omit(
        {
            ...baseQueryParams,
            ...queryParams,
        },
        "casesMetric",
        "deathsMetric",
        "cfrMetric",
        "testsMetric",
        "testsPerCaseMetric",
        "positiveTestRate",
        "vaccinationsMetric",
        "interval",
        "smoothing",
        "totalFreq",
        "dailyFreq"
    ) as QueryParams

    const explorerQueryParams: RawQueryParams = {
        "Metric Dropdown":
            covidMetricFromLegacyQueryParams(queryParams) ??
            covidMetricFromLegacyQueryParams(baseQueryParams),
        "Interval Dropdown":
            covidIntervalFromLegacyQueryParams(queryParams) ??
            covidIntervalFromLegacyQueryParams(baseQueryParams),
        "Align outbreaks Checkbox": aligned ? "true" : "false",
        "Relative to Population Checkbox": perCapita ? "true" : "false",
    }

    const patch = patchFromQueryParams({
        ...restQueryParams,
        ...rawQueryParamsToQueryParams(explorerQueryParams),
    })

    return {
        patch: patch.uriEncodedString,
    }
}

export const legacyCovidMigrationSpec: ExplorerUrlMigrationSpec = {
    explorerSlug: "coronavirus-data-explorer",
    migrateUrl: (url, baseQueryStr) => {
        url = legacyToCurrentGrapherUrl(url)
        let baseUrl = legacyToCurrentGrapherUrl(Url.fromQueryStr(baseQueryStr))
        url = url.update({
            pathname: `/${EXPLORERS_ROUTE_FOLDER}/coronavirus-data-explorer`,
            queryStr: queryParamsToStr(
                legacyToCurrentCovidQueryParams(url.queryStr, baseUrl.queryStr)
            ),
        })
        return url
    },
}
