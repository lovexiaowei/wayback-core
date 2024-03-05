import { getWaybackServiceBaseURL } from '../config';
import { lat2tile, long2tile } from '../helpers/geometry';
import { areUint8ArraysEqual } from '../helpers/unit8array';
import { WaybackItem } from '../types';
import {
    getWaybackItemByReleaseNumber,
    getWaybackItems,
} from '../wayback-items';

type Candidate = {
    /**
     * release number of a wayback item
     */
    releaseNumber: number;
    /**
     * url of a tile image from this wayback release
     */
    url: string;
};

type IResponseGetImageData = {
    releaseNumber: number;
    data: Uint8Array;
};

type IResponseWaybackTilemap = {
    data: Array<number>;
    select: Array<number>;
    valid: boolean;
    location: {
        left: number;
        top: number;
        width: number;
        height: number;
    };
};

/**
 * The following code initializes a Map named 'wabackItemsIndicemMap' intended to store
 * the index of each wayback item within the 'waybackItems' array. This Map facilitates
 * the retrieval of the index of a specific wayback item, which enables the identification
 * of the preceding wayback release in the array. This index reference is crucial for
 * identifying the wayback item that precedes a given one.
 */
let wabackItemsIndicemMap: Map<number, number> = null;

/**
 * Retrieves a list of world imagery wayback releases with local changes for a specified geographic point at a given zoom level.
 * It fetches wayback configuration data, find the release of wayback items with local changes, and determines unique release associated
 * with image tiles linked to local changes.
 *
 * @param point The geographic coordinates (longitude and latitude) of the location of interest, (e.g., `{longitude: -100.05, latitude: 35.10}`)
 * @param zoom The zoom level used to determine the level of detail for the geographic point
 * @abortController AbortController that will be used in case user needs to cancel the pending task
 * @returns {Promise<WaybackItem[]>} A Promise that resolves with an array of unique releases of wayback items
 *          associated with local changes for the given geographic point and zoom level.
 */
export const getWaybackItemsWithLocalChanges = async (
    point: {
        latitude: number;
        longitude: number;
    },
    zoom: number,
    abortController?: AbortController
): Promise<WaybackItem[]> => {
    const { longitude, latitude } = point;

    const level = +zoom.toFixed(0);
    const column = long2tile(longitude, level);
    const row = lat2tile(latitude, level);
    const releaseNums = await getReleaseNumOfWaybackItemsWithLocalChanges({
        column,
        row,
        level,
    });

    // Constructs Candidate objects with release numbers and corresponding image URLs
    const candidates: Candidate[] = [];

    for (const releaseNumber of releaseNums) {
        const { itemURL } = await getWaybackItemByReleaseNumber(releaseNumber);

        const candidate: Candidate = {
            releaseNumber,
            url: getTileImageUrl(itemURL, {
                column,
                row,
                level,
            }),
        };

        candidates.push(candidate);
    }
    // console.log(candidates)

    // Removes release with duplicate tile image data and extracts unique release numbers
    const rNumsNoDuplicates = await removeDuplicates(candidates);
    // console.log(rNumsNoDuplicates)

    const output: WaybackItem[] = [];

    for (const releaseNumber of rNumsNoDuplicates) {
        const waybackItem = await getWaybackItemByReleaseNumber(releaseNumber);
        output.push(waybackItem);
    }

    return new Promise((resolve, reject) => {
        if (abortController && abortController?.signal.aborted) {
            reject(
                'Task aborterd: getWaybackItemsWithLocalChanges has been aborterd by the user.'
            );
            return;
        }

        resolve(output);
    });
};

const getTileImageUrl = (
    urlTemplate: string,
    {
        column = null,
        row = null,
        level = null,
    }: {
        column: number;
        row: number;
        level: number;
    }
): string => {
    return urlTemplate
        .replace('{level}', level.toString())
        .replace('{row}', row.toString())
        .replace('{col}', column.toString());
};

/**
 * Determine the release number of the wayback item that precedes a given input release number
 * in a sequence of World Imagery Wayback releases.
 *
 * @param releaseNumber The release number of a specific wayback item to check for the preceding release
 * @returns The release number of the wayback item that was released immediately before the input release
 *          number. Returns null if no preceding wayback item exists or if the input is invalid.
 */
const getPreviouseReleaseNumber = async (
    releaseNumber: number
): Promise<number> => {
    // Retrieves an array of data for all World Imagery Wayback releases sorted by release date in descending order
    const waybackItems = await getWaybackItems();

    // Initialize and populate the `wabackItemsIndicemMap` if it's currently empty
    if (!wabackItemsIndicemMap) {
        wabackItemsIndicemMap = new Map();

        waybackItems.forEach((item, index) => {
            wabackItemsIndicemMap.set(item.releaseNum, index);
        });
    }

    // Obtain the index of the wayback item by its release number from the previously populated map
    const indexOfWaybackItem = wabackItemsIndicemMap.get(releaseNumber);

    // Determine the wayback item preceding the input release number, if available
    const previousItem = waybackItems[indexOfWaybackItem + 1]
        ? waybackItems[indexOfWaybackItem + 1]
        : null;

    // Return the release number of the identified previous wayback item, or null if none exists
    return previousItem?.releaseNum || null;
};

/**
 * retrieving an array containing release numbers of World Imagery Wayback items that encompass local changes.
 *
 * @param column Column coordinate for the tile
 * @param row Row coordinate for the tile
 * @param level Level of detail for the tile
 * @returns A Promise that resolves with an array containing release numbers associated with local changes
 *          found in World Imagery Wayback items.
 */
const getReleaseNumOfWaybackItemsWithLocalChanges = async ({
    column = null,
    row = null,
    level = null,
}: {
    column: number;
    row: number;
    level: number;
}): Promise<number[]> => {
    const waybackItems = await getWaybackItems();
    return new Promise((resolve, reject) => {
        const results: Array<number> = [];

        // release number of the latest wayback item
        const mostRecentRelease = waybackItems[0].releaseNum;
        const waybackMapServerBaseUrl = getWaybackServiceBaseURL();

        /**
         * Sending tilemap requests to retrieve information about a specific wayback release.
         * It performs a recursive operation to track wayback releases with local changes and builds an array of corresponding release numbers.
         *
         * Whenever we encounter a value in the 'data' property of the tilemap request response equal to `[1]`, we proceed to check for a release number in the 'select' property.
         * If a release number exists in the 'select' property, we add that release number to an array used for tracking releases with local changes. Otherwise, we add the release number
         * used for the current tilemap request to the same array. Afterward, to determine the release number for the subsequent tilemap request, we retrieve the release number preceding
         * the last one added to the array. We then initiate the tilemap request with this new release number and continue this process iteratively until reaching the earliest release
         * (i.e., the 2014 release with the release number 10).
         *
         * @param releaseNumber The release number used for the tilemap request
         * @returns A Promise that resolves with an array containing release numbers associated with local changes
         *          found in World Imagery Wayback items.
         */
        const tilemapRequest = async (releaseNumber: number) => {
            try {
                const requestUrl = `${waybackMapServerBaseUrl}/tilemap/${releaseNumber}/${level}/${row}/${column}`;

                const response = await fetch(requestUrl);

                const tilemapResponse: IResponseWaybackTilemap =
                    await response.json();

                // retrieve the release number of the closest version of thw wayback item that comes with local changes to the release number that you use for the tilemap request
                const lastReleaseCameWithLocalChange =
                    tilemapResponse.select && tilemapResponse.select[0]
                        ? +tilemapResponse.select[0]
                        : releaseNumber;

                // Checks for local changes and updates the results array accordingly
                if (tilemapResponse.data[0]) {
                    results.push(lastReleaseCameWithLocalChange);
                }

                // Obtains the release number to check for the previous wayback item
                const releaseNumOfNextWaybackItemToCheck = tilemapResponse
                    .data[0]
                    ? await getPreviouseReleaseNumber(
                          lastReleaseCameWithLocalChange
                      )
                    : null;

                if (releaseNumOfNextWaybackItemToCheck) {
                    tilemapRequest(releaseNumOfNextWaybackItemToCheck);
                } else {
                    resolve(results);
                }
            } catch (err) {
                console.error(err);
                reject(null);
            }
        };

        tilemapRequest(mostRecentRelease);
    });
};

/**
 * Asynchronous function removeDuplicates is responsible for processing an array of Candidate objects
 * to extract unique release numbers associated with image data URLs. It eliminates duplicate image data
 * and returns an array of unique release numbers.
 *
 * @param candidates (Optional) An array of Candidate objects containing URL and releaseNumber information
 * @returns A Promise that resolves with an array of unique release numbers extracted from the provided Candidates
 *          If the input array is empty or encounters an error during processing, it returns an empty array.
 */
const removeDuplicates = async (
    candidates?: Array<Candidate>
): Promise<Array<number>> => {
    if (!candidates.length) {
        return [];
    }

    // reverse the candidates list so the wayback items will be sorted by release dates in ascending order (oldest >>> latest)
    const imageDataRequests = candidates.reverse().map((candidate) => {
        return getImageData(candidate.url, candidate.releaseNumber);
    });

    // array of uniqeu image data with duplicated items removed
    const uniqueImageData: IResponseGetImageData[] = [];

    try {
        const imageDataResults = await Promise.all(imageDataRequests);

        for (const currentItem of imageDataResults) {
            const previousItem = uniqueImageData[uniqueImageData.length - 1];

            // image data of the currentItem is identical to the image data of the previous item,
            // skip pushing current data to the uniqueImageData list
            if (
                previousItem &&
                areUint8ArraysEqual(previousItem.data, currentItem.data)
            ) {
                continue;
            }

            uniqueImageData.push(currentItem);
        }
    } catch (err) {
        console.error('failed to fetch all image data uri', err);
    }

    // return release number of the items in the uniqueImageData array
    return uniqueImageData.map((d) => d.releaseNumber);
};

const getImageData = async (
    imageUrl: string,
    releaseNumber: number
): Promise<IResponseGetImageData> => {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', imageUrl, true);
        xhr.responseType = 'arraybuffer';

        xhr.onload = function () {
            if (this.status == 200) {
                const data = new Uint8Array(this.response);

                resolve({
                    releaseNumber,
                    data,
                });
            } else {
                reject();
            }
        };

        xhr.send();
    });
};
