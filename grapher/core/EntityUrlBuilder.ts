import { QueryParam } from "../../clientUtils/url"
import { EntityName } from "../../coreTable/OwidTableConstants"
import { LegacyEntityCodesToEntityNames } from "./LegacyEntityCodesToEntityNames"

// Todo: ensure EntityName never contains the v2Delimiter

const V1_DELIMITER = "+"
export const ENTITY_V2_DELIMITER = "~"

export class EntityUrlBuilder {
    static entityNamesToQueryParam(entityNames: EntityName[]) {
        // Always include a v2Delimiter in a v2 link. When decoding we will drop any empty strings.
        if (entityNames.length === 1)
            return ENTITY_V2_DELIMITER + entityNames[0]

        return entityNames.join(ENTITY_V2_DELIMITER)
    }

    static queryParamToEntityNames(queryParam: QueryParam): EntityName[] {
        // First preserve handling of the old v1 country=USA+FRA style links. If a link does not
        // include a v2Delimiter and includes a + we assume it's a v1 link. Unfortunately link sharing
        // with v1 links did not work on Facebook because FB would replace %20 with "+".
        if (queryParam._original === "") return []
        return this.isV1Link(queryParam)
            ? this.decodeV1Link(queryParam)
            : this.decodeV2Link(queryParam)
    }

    private static isV1Link(queryParam: QueryParam) {
        // No entities currently have a v2Delimiter in their name so if a v2Delimiter is present we know it's a v2 link.
        return !queryParam.decoded.includes(ENTITY_V2_DELIMITER)
    }

    private static decodeV1Link(queryParam: QueryParam) {
        return queryParam._original.split(V1_DELIMITER).map(decodeURIComponent)
    }

    private static decodeV2Link(queryParam: QueryParam) {
        return queryParam.decoded
            .split(ENTITY_V2_DELIMITER)
            .filter((item) => item)
    }

    /**
     * Old URLs may contain the selected entities by code or by their full name. In addition, some old urls contain a selection+dimension index combo. This methods
     * migrates those old urls.
     */
    static migrateLegacyCountryParam(countryParam: QueryParam | undefined) {
        if (countryParam === undefined) return []

        const names = this.queryParamToEntityNames(countryParam)
        const newNames: string[] = []
        names.forEach((name) => {
            // If an entity has the old name-dimension encoding, removing the dimension part and add it as a new selection. So USA-1 becomes USA.
            // This is only run against the old `country` params
            if (LegacyDimensionRegex.test(name))
                newNames.push(name.replace(LegacyDimensionRegex, ""))
            newNames.push(name)
        })

        return newNames.map(
            (name) => LegacyEntityCodesToEntityNames[name] ?? name
        )
    }
}

const LegacyDimensionRegex = /\-\d+$/
