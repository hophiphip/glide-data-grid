/* eslint-disable unicorn/consistent-destructuring */
import * as React from "react";
import { CellArray, GetCellsThunk, GridCellKind, Item, Rectangle } from "../data-grid/data-grid-types";
import ScrollingDataGrid, { ScrollingDataGridProps } from "../scrolling-data-grid/scrolling-data-grid";
import { SearchWrapper } from "./data-grid-search-style";
import { assert } from "../common/support";

// icons
const upArrow = (
    <svg className="button-icon" viewBox="0 0 512 512">
        <path
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="48"
            d="M112 244l144-144 144 144M256 120v292"
        />
    </svg>
);
const downArrow = (
    <svg className="button-icon" viewBox="0 0 512 512">
        <path
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="48"
            d="M112 268l144 144 144-144M256 392V100"
        />
    </svg>
);

const closeX = (
    <svg className="button-icon" viewBox="0 0 512 512">
        <path
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="32"
            d="M368 368L144 144M368 144L144 368"
        />
    </svg>
);

export type DataGridSearchLabels = {
    readonly progres?: (total: number, current: number) => string;
    readonly previous?: () => string;
    readonly close?: () => string;
    readonly hint?: () => string;
    readonly next?: () => string;
};

export interface DataGridSearchProps extends Omit<ScrollingDataGridProps, "prelightCells"> {
    readonly getCellsForSelection?: (selection: Rectangle, abortSignal: AbortSignal) => GetCellsThunk | CellArray;
    readonly onSearchResultsChanged?: (results: readonly Item[], navIndex: number) => void;
    readonly showSearch?: boolean;
    readonly onSearchClose?: () => void;
    readonly searchLabels?: DataGridSearchLabels;
}

const targetSearchTimeMS = 10;

const DataGridSearch: React.FunctionComponent<DataGridSearchProps> = p => {
    const {
        getCellsForSelection,
        onSearchResultsChanged,
        showSearch = false,
        onSearchClose,
        canvasRef,
        cellYOffset,
        rows,
        columns,
        searchLabels: customLabels,
    } = p;

    const searchLabels = React.useMemo(() => (
        { 
            progres: (total: number, current: number): string => {
                const result = total >= 1000
                    ? `over 1000` 
                    : `${total} results${total !== 1 ? "s" : ""}`;
                
                return current >= 0 
                    ? `${current + 1} of ${result}`
                    : result;                
            },
            previous: (): string => "Previous Result",
            close: (): string => "Close Search",
            hint: (): string => "Type to search",
            next: (): string => "Next Result", 
            ...customLabels 
        }
    ), [customLabels]);

    const [searchID] = React.useState(() => "search-box-" + Math.round(Math.random() * 1000));

    const [searchString, setSearchString] = React.useState("");
    const [searchStatus, setSearchStatus] = React.useState<{
        rowsSearched: number;
        results: number;
        selectedIndex: number;
    }>();

    const searchStatusRef = React.useRef(searchStatus);
    searchStatusRef.current = searchStatus;

    const abortControllerRef = React.useRef(new AbortController());
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const searchHandle = React.useRef<number>();
    const [searchResults, setSearchResults] = React.useState<readonly Item[]>([]);

    const cancelSearch = React.useCallback(() => {
        if (searchHandle.current !== undefined) {
            window.cancelAnimationFrame(searchHandle.current);
            searchHandle.current = undefined;
            abortControllerRef.current.abort();
        }
    }, []);

    const cellYOffsetRef = React.useRef(cellYOffset);
    cellYOffsetRef.current = cellYOffset;
    const beginSearch = React.useCallback(
        (str: string) => {
            const regex = new RegExp(str.replace(/([$()*+.?[\\\]^{|}-])/g, "\\$1"), "i");

            let startY = cellYOffsetRef.current;

            // Lets assume we can do 10 rows at a time
            // This is usually very safe and limits the damage for bad
            // performing sheets.
            let searchStride = Math.min(10, rows);

            let rowsSearched = 0;

            setSearchStatus(undefined);
            setSearchResults([]);

            const runningResult: [number, number][] = [];

            const tick = async () => {
                if (getCellsForSelection === undefined) return;
                const tStart = performance.now();
                const rowsLeft = rows - rowsSearched;
                let data = getCellsForSelection(
                    {
                        x: 0,
                        y: startY,
                        width: columns.length,
                        height: Math.min(searchStride, rowsLeft, rows - startY),
                    },
                    abortControllerRef.current.signal
                );

                if (typeof data === "function") {
                    data = await data();
                }

                let added = false;
                for (const [row, d] of data.entries()) {
                    for (const [col, cell] of d.entries()) {
                        let testString: string | undefined;
                        switch (cell.kind) {
                            case GridCellKind.Text:
                            case GridCellKind.Number:
                                testString = cell.displayData;
                                break;
                            case GridCellKind.Uri:
                            case GridCellKind.Markdown:
                                testString = cell.data;
                                break;
                            case GridCellKind.Boolean:
                                testString = typeof cell.data === "boolean" ? cell.data.toString() : undefined;
                                break;
                            case GridCellKind.Image:
                            case GridCellKind.Bubble:
                                // I know its lazy, but unless someone is actually
                                // searching for the whale emoji, this is pretty side effect
                                // free. And ya know... it's nice and easy to do...
                                testString = cell.data.join("🐳");
                                break;
                            case GridCellKind.Custom:
                                testString = cell.copyData;
                                break;
                        }

                        if (testString !== undefined && regex.test(testString)) {
                            runningResult.push([col, row + startY]);
                            added = true;
                        }
                    }
                }

                const tEnd = performance.now();

                if (added) {
                    setSearchResults([...runningResult]);
                }

                rowsSearched += data.length;
                assert(rowsSearched <= rows);

                const selectedIndex = searchStatusRef.current?.selectedIndex ?? -1;
                setSearchStatus({
                    results: runningResult.length,
                    rowsSearched,
                    selectedIndex,
                });
                onSearchResultsChanged?.(runningResult, selectedIndex);

                if (startY + searchStride >= rows) {
                    startY = 0;
                } else {
                    startY += searchStride;
                }

                const tElapsed = tEnd - tStart;
                const rounded = Math.max(tElapsed, 1);

                const scalar = targetSearchTimeMS / rounded;
                searchStride = Math.ceil(searchStride * scalar);

                if (rowsSearched < rows && runningResult.length < 1000) {
                    searchHandle.current = window.requestAnimationFrame(tick);
                }
            };

            cancelSearch();
            searchHandle.current = window.requestAnimationFrame(tick);
        },
        [cancelSearch, columns.length, getCellsForSelection, onSearchResultsChanged, rows]
    );

    const onClose = React.useCallback(() => {
        onSearchClose?.();
        setSearchStatus(undefined);
        setSearchResults([]);
        onSearchResultsChanged?.([], -1);
        cancelSearch();
        canvasRef?.current?.focus();
    }, [cancelSearch, canvasRef, onSearchClose, onSearchResultsChanged]);

    const onSearchChange = React.useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            setSearchString(event.target.value);
            if (event.target.value === "") {
                setSearchStatus(undefined);
                setSearchResults([]);
                cancelSearch();
            } else {
                beginSearch(event.target.value);
            }
        },
        [beginSearch, cancelSearch]
    );

    React.useEffect(() => {
        if (showSearch && inputRef.current !== null) {
            setSearchString("");
            inputRef.current.focus({ preventScroll: true });
        }
    }, [showSearch]);

    const onNext = React.useCallback(
        (ev?: React.MouseEvent) => {
            ev?.stopPropagation?.();
            if (searchStatus === undefined) return;
            const newIndex = (searchStatus.selectedIndex + 1) % searchStatus.results;
            setSearchStatus({
                ...searchStatus,
                selectedIndex: newIndex,
            });
            onSearchResultsChanged?.(searchResults, newIndex);
        },
        [searchStatus, onSearchResultsChanged, searchResults]
    );

    const onPrev = React.useCallback(
        (ev?: React.MouseEvent) => {
            ev?.stopPropagation?.();
            if (searchStatus === undefined) return;
            let newIndex = (searchStatus.selectedIndex - 1) % searchStatus.results;
            if (newIndex < 0) newIndex += searchStatus.results;
            setSearchStatus({
                ...searchStatus,
                selectedIndex: newIndex,
            });
            onSearchResultsChanged?.(searchResults, newIndex);
        },
        [onSearchResultsChanged, searchResults, searchStatus]
    );

    const onSearchKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (((event.ctrlKey || event.metaKey) && event.nativeEvent.code === "KeyF") || event.key === "Escape") {
                onClose();
                event.stopPropagation();
                event.preventDefault();
            } else if (event.key === "Enter") {
                if (event.shiftKey) {
                    onPrev();
                } else {
                    onNext();
                }
            }
        },
        [onClose, onNext, onPrev]
    );

    // cancel search if the component is unmounted
    React.useEffect(() => {
        return () => {
            cancelSearch();
        };
    }, [cancelSearch]);

    const searchbox = React.useMemo(() => {
        let resultString: string | undefined;
        if (searchStatus !== undefined) {
            resultString = 
                searchLabels.progres?.(searchStatus.results, searchStatus.selectedIndex);
        }

        const cancelEvent = (ev: React.MouseEvent) => {
            ev.stopPropagation();
        };

        const rowsSearchedProgress = Math.floor(((searchStatus?.rowsSearched ?? 0) / rows) * 100);
        const progressStyle: React.CSSProperties = {
            width: `${rowsSearchedProgress}%`,
        };

        return (
            <SearchWrapper
                showSearch={showSearch}
                onMouseDown={cancelEvent}
                onMouseMove={cancelEvent}
                onMouseUp={cancelEvent}
                onClick={cancelEvent}>
                <div className="search-bar-inner">
                    <input
                        id={searchID}
                        aria-hidden={!showSearch}
                        data-testid="search-input"
                        ref={inputRef}
                        onChange={onSearchChange}
                        value={searchString}
                        tabIndex={showSearch ? undefined : -1}
                        onKeyDownCapture={onSearchKeyDown}
                    />
                    <button
                        aria-label={searchLabels.previous?.()}
                        aria-hidden={!showSearch}
                        tabIndex={showSearch ? undefined : -1}
                        onClick={onPrev}
                        disabled={(searchStatus?.results ?? 0) === 0}>
                        {upArrow}
                    </button>
                    <button
                        aria-label={searchLabels.next?.()}
                        aria-hidden={!showSearch}
                        tabIndex={showSearch ? undefined : -1}
                        onClick={onNext}
                        disabled={(searchStatus?.results ?? 0) === 0}>
                        {downArrow}
                    </button>
                    {onSearchClose !== undefined && (
                        <button
                            aria-label={searchLabels.close?.()}
                            aria-hidden={!showSearch}
                            data-testid="search-close-button"
                            tabIndex={showSearch ? undefined : -1}
                            onClick={onClose}>
                            {closeX}
                        </button>
                    )}
                </div>
                {searchStatus !== undefined ? (
                    <>
                        <div className="search-status">
                            <div data-testid="search-result-area">{resultString}</div>
                        </div>
                        <div className="search-progress" style={progressStyle} />
                    </>
                ) : (
                    <div className="search-status">
                        <label htmlFor={searchID}>
                            {searchLabels.hint?.()}
                        </label>
                    </div>
                )}
            </SearchWrapper>
        );
    }, [
        onClose,
        onNext,
        onPrev,
        onSearchChange,
        onSearchClose,
        onSearchKeyDown,
        rows,
        searchStatus,
        searchString,
        showSearch,
        searchID,
        searchLabels,
    ]);

    return (
        <>
            <ScrollingDataGrid
                // Dear future developer. I am sorry.
                accessibilityHeight={p.accessibilityHeight}
                cellXOffset={p.cellXOffset}
                cellYOffset={p.cellYOffset}
                columns={p.columns}
                enableGroups={p.enableGroups}
                freezeColumns={p.freezeColumns}
                preventDiagonalScrolling={p.preventDiagonalScrolling}
                getCellContent={p.getCellContent}
                groupHeaderHeight={p.groupHeaderHeight}
                onCanvasFocused={p.onCanvasFocused}
                onCanvasBlur={p.onCanvasBlur}
                isFocused={p.isFocused}
                clientSize={p.clientSize}
                headerHeight={p.headerHeight}
                onContextMenu={p.onContextMenu}
                isFilling={p.isFilling}
                fillHandle={p.fillHandle}
                trailingRowType={p.trailingRowType}
                firstColAccessible={p.firstColAccessible}
                lockColumns={p.lockColumns}
                rowHeight={p.rowHeight}
                onMouseMove={p.onMouseMove}
                rows={p.rows}
                highlightRegions={p.highlightRegions}
                verticalBorder={p.verticalBorder}
                canvasRef={p.canvasRef}
                className={p.className}
                theme={p.theme}
                disabledRows={p.disabledRows}
                drawCustomCell={p.drawCustomCell}
                drawHeader={p.drawHeader}
                experimental={p.experimental}
                getGroupDetails={p.getGroupDetails}
                getRowThemeOverride={p.getRowThemeOverride}
                gridRef={p.gridRef}
                headerIcons={p.headerIcons}
                isDraggable={p.isDraggable}
                onDragEnd={p.onDragEnd}
                minColumnWidth={p.minColumnWidth}
                maxColumnWidth={p.maxColumnWidth}
                onCellFocused={p.onCellFocused}
                onColumnMoved={p.onColumnMoved}
                onColumnResize={p.onColumnResize}
                onColumnResizeStart={p.onColumnResizeStart}
                onColumnResizeEnd={p.onColumnResizeEnd}
                onDragStart={p.onDragStart}
                onDragOverCell={p.onDragOverCell}
                onDragLeave={p.onDragLeave}
                onDrop={p.onDrop}
                onHeaderMenuClick={p.onHeaderMenuClick}
                onItemHovered={p.onItemHovered}
                onKeyUp={p.onKeyUp}
                onMouseDown={p.onMouseDown}
                onMouseUp={p.onMouseUp}
                onRowMoved={p.onRowMoved}
                onVisibleRegionChanged={p.onVisibleRegionChanged}
                overscrollX={p.overscrollX}
                overscrollY={p.overscrollY}
                rightElement={p.rightElement}
                rightElementProps={p.rightElementProps}
                scrollRef={p.scrollRef}
                scrollToEnd={p.scrollToEnd}
                selection={p.selection}
                showMinimap={p.showMinimap}
                smoothScrollX={p.smoothScrollX}
                smoothScrollY={p.smoothScrollY}
                translateX={p.translateX}
                translateY={p.translateY}
                onKeyDown={p.onKeyDown}
                // handled props
                prelightCells={searchResults}
            />
            {searchbox}
        </>
    );
};

export default DataGridSearch;
