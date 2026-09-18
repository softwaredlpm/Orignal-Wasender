param(
    [string]$Action,
    [string]$Data,
    [string]$DbPath,
    [string]$DbPassword,
    [string]$DbType = "Access",
    [string]$DbServer = "",
    [string]$DbUser = ""
)

# Connection Logic
$Conn = New-Object -ComObject ADODB.Connection

if ($DbType -eq "MSSQL") {
    # MSSQL Connection
    if ([string]::IsNullOrWhiteSpace($DbServer)) { 
        Write-Error "MSSQL Server Name is required."
        exit 1
    }
    # For MSSQL, DbPath is treated as Database Name (e.g., COMP0018 or BusyComp0003_db12025)
    $DbName = $DbPath

    $ConnStrings = @()
    if (-not [string]::IsNullOrWhiteSpace($DbUser)) {
        $ConnStrings += "Provider=SQLOLEDB;Data Source=$DbServer;Initial Catalog=$DbName;User ID=$DbUser;Password=$DbPassword;"
        $ConnStrings += "Provider=MSOLEDBSQL;Data Source=$DbServer;Initial Catalog=$DbName;User ID=$DbUser;Password=$DbPassword;"
    }
    $ConnStrings += "Provider=SQLOLEDB;Data Source=$DbServer;Initial Catalog=$DbName;Integrated Security=SSPI;"
    $ConnStrings += "Provider=MSOLEDBSQL;Data Source=$DbServer;Initial Catalog=$DbName;Integrated Security=SSPI;"

    $Connected = $false
    $LastError = ""

    foreach ($cs in $ConnStrings) {
        try {
            $Conn.Open($cs)
            $Connected = $true
            break
        } catch {
            $LastError = $_.Exception.Message
        }
    }

    if (-not $Connected) {
        $Host.UI.WriteErrorLine("MSSQL Connection Failed: $LastError")
        exit 1
    }
}
else {
    # Access Connection (Default)
    if ([string]::IsNullOrWhiteSpace($DbPassword)) { $DbPassword = "ILoveMyINDIA" }

    if ([string]::IsNullOrWhiteSpace($DbPath)) {
        # Fallback to config only if path is MISSING (safety net)
        $ConfigPath = Join-Path $PSScriptRoot "busy_config.json"
        if (Test-Path $ConfigPath) {
            $Config = Get-Content $ConfigPath | ConvertFrom-Json
            $DbPath = $Config.dbPath
        }
    }

    if (Test-Path $DbPath) {
        if (Test-Path $DbPath -PathType Container) {
            $LatestFile = Get-ChildItem -Path $DbPath -Filter "*.bds" | Sort-Object Name -Descending | Select-Object -First 1
            if ($LatestFile) { $DbPath = $LatestFile.FullName }
        }
        else {
            $Parent = Split-Path $DbPath
            $LatestFile = Get-ChildItem -Path $Parent -Filter "*.bds" | Sort-Object Name -Descending | Select-Object -First 1
            if ($LatestFile) { $DbPath = $LatestFile.FullName }
        }
    }
    $ConnStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$DbPath;Persist Security Info=False;Jet OLEDB:Database Password=$DbPassword;"
    
    try {
        $Conn.Open($ConnStr)
    }
    catch { 
        $Host.UI.WriteErrorLine($_.Exception.Message)
        exit 1 
    }
}

function Get-QueryResults($Query) {
    try { $RS = $Conn.Execute($Query) } catch { Write-Error "Query Failed: $($_.Exception.Message) | Query: $Query"; return @() }
    $Result = @()
    if ($null -eq $RS -or ($RS.EOF -and $RS.BOF)) { return @() }
    while (-not $RS.EOF) {
        $Row = @{}
        for ($i = 0; $i -lt $RS.Fields.Count; $i++) {
            $Fld = $RS.Fields.Item($i)
            $Val = $Fld.Value
            if ($null -eq $Val -or $Val -is [System.DBNull]) {
                $Row[$Fld.Name] = $null
            }
            elseif ($Val -is [string]) {
                $Row[$Fld.Name] = $Val.Trim()
            }
            else {
                $Row[$Fld.Name] = $Val
            }
        }
        $Result += $Row
        $RS.MoveNext()
    }
    return @($Result)
}

if ($Action -eq "RESOLVE_PATH") { @{ path = $DbPath } | ConvertTo-Json -Compress }
elseif ($Action -eq "GET_PDC_ALERTS") {
    $DateQuote = if ($DbType -eq "MSSQL") { "'" } else { "#" }
    $DateFmt = if ($DbType -eq "MSSQL") { "yyyy-MM-dd" } else { "yyyy/MM/dd" }

    # Get the target date strings
    $TMinus1Str = (Get-Date).AddDays(-1).ToString($DateFmt)
    $TodayStr = (Get-Date).ToString($DateFmt)
    $T1Str = (Get-Date).AddDays(1).ToString($DateFmt)
    $T2Str = (Get-Date).AddDays(2).ToString($DateFmt)

    $PDCDateExpr = if ($DbType -eq "MSSQL") { "CONVERT(varchar, T1.StockUpdationDate, 23)" } else { "T1.StockUpdationDate" }

    $FromClause = "FROM Tran1 T1
    INNER JOIN Tran2 T2 ON T1.VchCode = T2.VchCode
    INNER JOIN Help1 H1 ON T2.MasterCode1 = H1.Code
    LEFT JOIN MasterAddressInfo M1 ON T2.MasterCode1 = M1.MasterCode
    LEFT JOIN Help1 H2 ON H1.ParentGroup = H2.Code"
    
    if ($DbType -eq "Access") {
        $FromClause = "FROM ((((Tran1 T1
        INNER JOIN Tran2 T2 ON T1.VchCode = T2.VchCode)
        INNER JOIN Help1 H1 ON T2.MasterCode1 = H1.Code)
        LEFT JOIN MasterAddressInfo M1 ON T2.MasterCode1 = M1.MasterCode)
        LEFT JOIN Help1 H2 ON H1.ParentGroup = H2.Code)"
    }

    $Sql = "SELECT 
        T1.VchCode,
        T1.VchType,
        T1.VchNo,
        T1.[Date] AS VoucherDate,
        $PDCDateExpr AS PDCDate,
        T2.MasterCode1 AS PartyCode,
        H1.NameAlias AS AccountName,
        H1.ParentGroup AS ParentGroupCode,
        H2.NameAlias AS ParentGroupName,
        T2.Value1 AS Amount,
        T2.ShortNar AS Narration,
        M1.Mobile,
        M1.WhatsAppNo
    $FromClause
    WHERE T1.StockUpdationDate IN ($DateQuote$TMinus1Str$DateQuote, $DateQuote$TodayStr$DateQuote, $DateQuote$T1Str$DateQuote, $DateQuote$T2Str$DateQuote)
    AND T1.VchType IN (11, 14, 18, 19)"
    
    Get-QueryResults $Sql | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_ACCOUNTS") {
    $Sql = "SELECT Code, NameAlias, ParentGroup, MasterType FROM Help1"
    Get-QueryResults $Sql | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "CUSTOM") {
    $Sql = $Data
    Get-QueryResults $Sql | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_MATERIAL_CENTERS") {
    $Sql = "SELECT H.Code, H.NameAlias AS Name, ISNULL(G.NameAlias, 'Ungrouped') AS GroupName 
            FROM Help1 H 
            LEFT JOIN Help1 G ON H.ParentGroup = G.Code 
            WHERE H.MasterType = 11"
    Get-QueryResults $Sql | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_BATCH_CLOSING_STOCK") {
    $SearchText = ""
    $McFilters = @()
    
    if (-not [string]::IsNullOrWhiteSpace($Data)) {
        if ($Data.Trim().StartsWith("{")) {
            try {
                $DataObj = $Data | ConvertFrom-Json
                if ($null -ne $DataObj.search) { $SearchText = [string]$DataObj.search }
                if ($null -ne $DataObj.mcs -and $DataObj.mcs.Count -gt 0) { $McFilters = $DataObj.mcs }
            } catch {
                $SearchText = $Data
            }
        } else {
            $SearchText = $Data
        }
    }

    $SearchFilter = ""
    if (-not [string]::IsNullOrWhiteSpace($SearchText)) {
        $EscapedData = $SearchText.Replace("'", "''")
        $SearchFilter = " AND (M1.Name LIKE '%$EscapedData%' OR MC.Name LIKE '%$EscapedData%')"
    }
    
    if ($McFilters.Count -gt 0) {
        $McInClause = ($McFilters | ForEach-Object { "'$($_ -replace "'", "''")'" }) -join ","
        $SearchFilter += " AND MC.Name IN ($McInClause)"
    }

    $Sql = "SELECT 
                M1.Name AS ItemName,
                MC.Name AS PartyName,
                LTRIM(RTRIM(T.No)) AS BatchNo,
                CONVERT(VARCHAR(10), MAX(T.VchDate), 105) AS VchDate,
                SUM(CASE WHEN T.NetVal > 0 THEN T.NetVal ELSE 0 END) AS QtyIn,
                SUM(CASE WHEN T.NetVal < 0 THEN ABS(T.NetVal) ELSE 0 END) AS QtyOut,
                SUM(T.NetVal) AS ClosingQty
            FROM (
                SELECT 
                    T3.MasterCode1, 
                    LTRIM(RTRIM(T3.No)) AS No, 
                    T3.MasterCode2, 
                    T3.VchCode,
                    MAX(T3.Date) AS VchDate,
                    SUM(T3.Value1) AS NetVal
                FROM Tran3 T3
                WHERE LTRIM(RTRIM(T3.No)) <> ''
                GROUP BY T3.MasterCode1, LTRIM(RTRIM(T3.No)), T3.MasterCode2, T3.VchCode
                HAVING ROUND(SUM(T3.Value1), 2) <> 0
            ) T
            INNER JOIN Master1 M1 ON T.MasterCode1 = M1.Code
            INNER JOIN Master1 MC ON T.MasterCode2 = MC.Code
            LEFT JOIN (
                SELECT T3.MasterCode1, LTRIM(RTRIM(T3.No)) AS No, T3.MasterCode2, MAX(T1.MasterCode1) AS PartyCode
                FROM Tran3 T3
                INNER JOIN Tran1 T1 ON T3.VchCode = T1.VchCode
                WHERE T3.Status = 1
                GROUP BY T3.MasterCode1, LTRIM(RTRIM(T3.No)), T3.MasterCode2
            ) PartyRef ON T.MasterCode1 = PartyRef.MasterCode1 AND T.No = PartyRef.No AND T.MasterCode2 = PartyRef.MasterCode2
            LEFT JOIN Master1 Party ON PartyRef.PartyCode = Party.Code
            WHERE 1=1 $SearchFilter 
            GROUP BY M1.Name, Party.Name, MC.Name, T.No
            HAVING ROUND(SUM(T.NetVal), 2) <> 0
            ORDER BY MC.Name ASC, M1.Name ASC, T.No ASC"


    Get-QueryResults $Sql | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_CLOSING_STOCK") {
    $ItemTotals = @{}
    $ItemNames = @{}

    $SearchText = ""
    $McCode = $null
    
    if (-not [string]::IsNullOrWhiteSpace($Data)) {
        if ($Data.Trim().StartsWith("{")) {
            try {
                $DataObj = $Data | ConvertFrom-Json
                if ($null -ne $DataObj.search) { $SearchText = [string]$DataObj.search }
                if ($null -ne $DataObj.mcCode -and [string]$DataObj.mcCode -ne "") { $McCode = [string]$DataObj.mcCode }
            } catch {
                $SearchText = $Data
            }
        } else {
            $SearchText = $Data
        }
    }

    $FilterClause = ""
    $TranFilterClause = ""
    if (-not [string]::IsNullOrWhiteSpace($SearchText)) {
        $EscapedData = $SearchText.Replace("'", "''")
        $FilterClause = " AND H.NameAlias LIKE '%$EscapedData%'"
        $TranFilterClause = " AND M.Name LIKE '%$EscapedData%'"
    }

    if ($DbType -eq "MSSQL") {
        # 1. Fetch Item Master & Opening Stock from SQL Server database ($Conn)
        $Sql1 = "SELECT H.Code, H.NameAlias AS ItemName, F.D1 AS OpQty 
                 FROM Help1 H LEFT JOIN Folio1 F ON (H.Code = F.MasterCode AND F.MasterType = 6) 
                 WHERE H.MasterType = 6 $FilterClause"
        
        try {
            $RS0 = $Conn.Execute($Sql1)
            if ($null -ne $RS0 -and -not ($RS0.EOF -and $RS0.BOF)) {
                while (-not $RS0.EOF) {
                    $code = $RS0.Fields.Item('Code').Value
                    $name = $RS0.Fields.Item('ItemName').Value
                    $opQty = $RS0.Fields.Item('OpQty').Value
                    if ($null -ne $code -and -not ($code -is [System.DBNull])) {
                        $ItemNames[$code] = if ($null -ne $name -and -not ($name -is [System.DBNull])) { [string]$name } else { "" }
                        if ($null -ne $opQty -and -not ($opQty -is [System.DBNull])) {
                            $ItemTotals[$code] = [double]$opQty
                        } else {
                            $ItemTotals[$code] = 0
                        }
                    }
                    $RS0.MoveNext()
                }
            }
        } catch {
            [Console]::Error.WriteLine("[PS-BRIDGE] MSSQL Stock Sql1 Error: $($_.Exception.Message)")
        }

        # 2. Add Current Financial Year Transactions (Tran2 RecType 2, 20)
        $Sql2 = "SELECT M.Code, M.Name AS ItemName, 
                       SUM(ISNULL(T2.Value1, 0)) AS TranQty
                FROM Master1 M INNER JOIN Tran2 T2 ON M.Code = T2.MasterCode1
                WHERE M.MasterType = 6 AND T2.RecType IN (2, 20) $TranFilterClause
                GROUP BY M.Code, M.Name"

        try {
            $RS2 = $Conn.Execute($Sql2)
            if ($null -ne $RS2 -and -not ($RS2.EOF -and $RS2.BOF)) {
                while (-not $RS2.EOF) {
                    $code = $RS2.Fields.Item('Code').Value
                    $name = $RS2.Fields.Item('ItemName').Value
                    $tranQty = $RS2.Fields.Item('TranQty').Value
                    if ($null -ne $code -and -not ($code -is [System.DBNull])) {
                        if ($null -ne $tranQty -and -not ($tranQty -is [System.DBNull])) {
                            if (-not $ItemTotals.ContainsKey($code)) { $ItemTotals[$code] = 0 }
                            $ItemTotals[$code] += [double]$tranQty
                            if ($null -ne $name -and -not ($name -is [System.DBNull]) -and [string]::IsNullOrWhiteSpace($ItemNames[$code])) {
                                $ItemNames[$code] = [string]$name
                            }
                        }
                    }
                    $RS2.MoveNext()
                }
            }
        } catch {
            [Console]::Error.WriteLine("[PS-BRIDGE] MSSQL Stock Sql2 Error: $($_.Exception.Message)")
        }

        # Dynamic Primary Material Center Code Detection
        $PrimaryMcCode = "201"
        try {
            $RSMC = $Conn.Execute("SELECT TOP 1 Code FROM Help1 WHERE MasterType = 11 ORDER BY Code")
            if ($null -ne $RSMC -and -not ($RSMC.EOF -and $RSMC.BOF)) {
                $PrimaryMcCode = [string]$RSMC.Fields.Item('Code').Value
            }
        } catch {}

        # Material Center Filtering
        if (-not [string]::IsNullOrWhiteSpace($McCode)) {
            $McTotals = @{}

            # 1. Opening Stock for specific MC from Tran4 (RecType=0)
            try {
                $SqlSecOp = "SELECT T4.MasterCode1, M.Name AS ItemName, SUM(T4.D1) AS SumVal 
                             FROM Tran4 T4 INNER JOIN Master1 M ON T4.MasterCode1 = M.Code 
                             WHERE M.MasterType = 6 AND T4.RecType = 0 AND T4.MasterCode2 = $McCode $TranFilterClause 
                             GROUP BY T4.MasterCode1, M.Name"
                $rssOp = $Conn.Execute($SqlSecOp)
                if ($null -ne $rssOp -and -not ($rssOp.EOF -and $rssOp.BOF)) {
                    while (-not $rssOp.EOF) {
                        $c = $rssOp.Fields.Item('MasterCode1').Value
                        $n = $rssOp.Fields.Item('ItemName').Value
                        $v = $rssOp.Fields.Item('SumVal').Value
                        if ($null -ne $c -and -not ($c -is [System.DBNull]) -and $null -ne $v -and -not ($v -is [System.DBNull])) {
                            if (-not $McTotals.ContainsKey($c)) { $McTotals[$c] = 0 }
                            $McTotals[$c] += [double]$v
                            if ($null -ne $n -and -not ($n -is [System.DBNull])) {
                                $ItemNames[$c] = [string]$n
                            }
                        }
                        $rssOp.MoveNext()
                    }
                }
            } catch {}

            # 2. Transactions for specific MC from Tran2
            try {
                $SqlSecTran = "SELECT M.Code, M.Name AS ItemName, SUM(T2.Value1) AS SumVal 
                           FROM Master1 M INNER JOIN Tran2 T2 ON M.Code = T2.MasterCode1 
                           WHERE M.MasterType = 6 AND T2.RecType IN (2, 20) AND T2.MasterCode2 = $McCode $TranFilterClause 
                           GROUP BY M.Code, M.Name"
                $rssTran = $Conn.Execute($SqlSecTran)
                if ($null -ne $rssTran -and -not ($rssTran.EOF -and $rssTran.BOF)) {
                    while (-not $rssTran.EOF) {
                        $c = $rssTran.Fields.Item('Code').Value
                        $n = $rssTran.Fields.Item('ItemName').Value
                        $v = $rssTran.Fields.Item('SumVal').Value
                        if ($null -ne $c -and -not ($c -is [System.DBNull]) -and $null -ne $v -and -not ($v -is [System.DBNull])) {
                            if (-not $McTotals.ContainsKey($c)) { $McTotals[$c] = 0 }
                            $McTotals[$c] += [double]$v
                            if ($null -ne $n -and -not ($n -is [System.DBNull])) {
                                $ItemNames[$c] = [string]$n
                            }
                        }
                        $rssTran.MoveNext()
                    }
                }
            } catch {}

            # If it's the primary MC and Tran4 returned NOTHING for all items, fallback to using overall opening stock
            if ([string]$McCode -eq $PrimaryMcCode -and $McTotals.Keys.Count -eq 0) {
                # Fallback: Assume all Folio1 opening stock belongs to Main Store
                foreach ($code in $ItemTotals.Keys) {
                    $McTotals[$code] = $ItemTotals[$code]
                }
                # But we must subtract the TRANSACTIONS of OTHER material centers to avoid double counting
                $SecMcMap = @{}
                try {
                    $SqlSec = "SELECT MasterCode1, SUM(Value1) AS SumVal FROM Tran2 WHERE MasterCode2 <> $PrimaryMcCode AND MasterCode2 <> 0 AND RecType IN (2, 20) GROUP BY MasterCode1"
                    $rss = $Conn.Execute($SqlSec)
                    if ($null -ne $rss -and -not ($rss.EOF -and $rss.BOF)) {
                        while (-not $rss.EOF) {
                            $c = $rss.Fields.Item('MasterCode1').Value
                            $v = $rss.Fields.Item('SumVal').Value
                            if ($null -ne $c -and -not ($c -is [System.DBNull]) -and $null -ne $v -and -not ($v -is [System.DBNull])) {
                                if (-not $SecMcMap.ContainsKey($c)) { $SecMcMap[$c] = 0 }
                                $SecMcMap[$c] += [double]$v
                            }
                            $rss.MoveNext()
                        }
                    }
                } catch {}

                foreach ($code in $McTotals.Keys) {
                    if ($SecMcMap.ContainsKey($code)) {
                        $McTotals[$code] -= $SecMcMap[$code]
                    }
                }
            }

            $ItemTotals = $McTotals
        }
    } else {
        # Access Logic (Existing implementation)
        $CompanyDir = if (Test-Path $DbPath -PathType Container) { $DbPath } else { Split-Path $DbPath }
        $DbFiles = Get-ChildItem -Path $CompanyDir -Filter "db120*.bds" | Sort-Object Name
        if (-not $DbFiles) {
            $DbFiles = Get-ChildItem -Path $CompanyDir -Filter "*.bds" | Where-Object { $_.Name -ne "db.bds" } | Sort-Object Name
        }
        $LatestFile = $DbFiles | Select-Object -Last 1
        if (-not $LatestFile -and (Test-Path $DbPath -PathType Leaf)) {
            $LatestFile = Get-Item -Path $DbPath
            $DbFiles = @($LatestFile)
        }

        if ($LatestFile) {
            $FileConnStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$($LatestFile.FullName);Persist Security Info=False;Jet OLEDB:Database Password=$DbPassword;"
            try {
                $FConn = New-Object -ComObject ADODB.Connection
                $FConn.Open($FileConnStr)

                # 1. Fetch Item Master & Opening Stock (Folio1 D1) from Latest Year
                $Sql1 = "SELECT H.Code, H.NameAlias AS ItemName, F.D1 AS OpQty 
                         FROM Help1 H LEFT JOIN Folio1 F ON (H.Code = F.MasterCode AND F.MasterType = 6) 
                         WHERE H.MasterType = 6 $FilterClause"
                
                try {
                    $RS0 = $FConn.Execute($Sql1)
                    if ($null -ne $RS0 -and -not ($RS0.EOF -and $RS0.BOF)) {
                        while (-not $RS0.EOF) {
                            $code = $RS0.Fields.Item('Code').Value
                            $name = $RS0.Fields.Item('ItemName').Value
                            $opQty = $RS0.Fields.Item('OpQty').Value
                            $ItemNames[$code] = $name
                            if ($null -ne $opQty -and -not ($opQty -is [System.DBNull])) {
                                $ItemTotals[$code] = [double]$opQty
                            } else {
                                $ItemTotals[$code] = 0
                            }
                            $RS0.MoveNext()
                        }
                    }
                } catch {}

                # 2. Add Current Financial Year Transactions (Tran2 RecType 2, 20)
                $Sql2 = "SELECT M.Code, M.Name AS ItemName, 
                               SUM(IIf(T2.Value1 IS NULL, 0, T2.Value1)) AS TranQty
                        FROM Master1 M INNER JOIN Tran2 T2 ON M.Code = T2.MasterCode1
                        WHERE M.MasterType = 6 AND T2.RecType IN (2, 20) $TranFilterClause
                        GROUP BY M.Code, M.Name"

                try {
                    $RS2 = $FConn.Execute($Sql2)
                    if ($null -ne $RS2 -and -not ($RS2.EOF -and $RS2.BOF)) {
                        while (-not $RS2.EOF) {
                            $code = $RS2.Fields.Item('Code').Value
                            $name = $RS2.Fields.Item('ItemName').Value
                            $tranQty = $RS2.Fields.Item('TranQty').Value
                            if ($null -ne $tranQty -and -not ($tranQty -is [System.DBNull])) {
                                if (-not $ItemTotals.ContainsKey($code)) { $ItemTotals[$code] = 0 }
                                $ItemTotals[$code] += [double]$tranQty
                                $ItemNames[$code] = $name
                            }
                            $RS2.MoveNext()
                        }
                    }
                } catch {}

                $FConn.Close()
            } catch {}
        }

        # Dynamic Primary Material Center Code Detection
        $PrimaryMcCode = "201"
        if ($LatestFile) {
            try {
                $FConnMC = New-Object -ComObject ADODB.Connection
                $FConnMC.Open($FileConnStr)
                $RSMC = $FConnMC.Execute("SELECT TOP 1 Code FROM Help1 WHERE MasterType = 11 ORDER BY Code")
                if ($null -ne $RSMC -and -not ($RSMC.EOF -and $RSMC.BOF)) {
                    $PrimaryMcCode = [string]$RSMC.Fields.Item('Code').Value
                }
                $FConnMC.Close()
            } catch {}
        }

        # If specific Material Center is requested:
        if (-not [string]::IsNullOrWhiteSpace($McCode)) {
            $McTotals = @{}

            # 1. Opening Stock for specific MC from Tran4 (RecType=0)
            foreach ($file in $DbFiles) {
                $fStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$($file.FullName);Persist Security Info=False;Jet OLEDB:Database Password=$DbPassword;"
                try {
                    $fc = New-Object -ComObject ADODB.Connection
                    $fc.Open($fStr)
                    $SqlSecOp = "SELECT T4.MasterCode1, M.Name AS ItemName, SUM(T4.D1) AS SumVal 
                                 FROM Tran4 T4 INNER JOIN Master1 M ON T4.MasterCode1 = M.Code 
                                 WHERE M.MasterType = 6 AND T4.RecType = 0 AND T4.MasterCode2 = $McCode $TranFilterClause 
                                 GROUP BY T4.MasterCode1, M.Name"
                    $rssOp = $fc.Execute($SqlSecOp)
                    if ($null -ne $rssOp -and -not ($rssOp.EOF -and $rssOp.BOF)) {
                        while (-not $rssOp.EOF) {
                            $c = $rssOp.Fields.Item('MasterCode1').Value
                            $n = $rssOp.Fields.Item('ItemName').Value
                            $v = $rssOp.Fields.Item('SumVal').Value
                            if ($null -ne $c -and -not ($c -is [System.DBNull]) -and $null -ne $v -and -not ($v -is [System.DBNull])) {
                                if (-not $McTotals.ContainsKey($c)) { $McTotals[$c] = 0 }
                                $McTotals[$c] += [double]$v
                                if ($null -ne $n -and -not ($n -is [System.DBNull])) {
                                    $ItemNames[$c] = [string]$n
                                }
                            }
                            $rssOp.MoveNext()
                        }
                    }
                    $fc.Close()
                } catch {}
            }

            # 2. Transactions for specific MC from Tran2
            foreach ($file in $DbFiles) {
                $fStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$($file.FullName);Persist Security Info=False;Jet OLEDB:Database Password=$DbPassword;"
                try {
                    $fc = New-Object -ComObject ADODB.Connection
                    $fc.Open($fStr)
                    $SqlSecTran = "SELECT M.Code, M.Name AS ItemName, SUM(T2.Value1) AS SumVal 
                               FROM Master1 M INNER JOIN Tran2 T2 ON M.Code = T2.MasterCode1 
                               WHERE M.MasterType = 6 AND T2.RecType IN (2, 20) AND T2.MasterCode2 = $McCode $TranFilterClause 
                               GROUP BY M.Code, M.Name"
                    $rssTran = $fc.Execute($SqlSecTran)
                    if ($null -ne $rssTran -and -not ($rssTran.EOF -and $rssTran.BOF)) {
                        while (-not $rssTran.EOF) {
                            $c = $rssTran.Fields.Item('Code').Value
                            $n = $rssTran.Fields.Item('ItemName').Value
                            $v = $rssTran.Fields.Item('SumVal').Value
                            if ($null -ne $c -and -not ($c -is [System.DBNull]) -and $null -ne $v -and -not ($v -is [System.DBNull])) {
                                if (-not $McTotals.ContainsKey($c)) { $McTotals[$c] = 0 }
                                $McTotals[$c] += [double]$v
                                if ($null -ne $n -and -not ($n -is [System.DBNull])) {
                                    $ItemNames[$c] = [string]$n
                                }
                            }
                            $rssTran.MoveNext()
                        }
                    }
                    $fc.Close()
                } catch {}
            }

            # If it's the primary MC and Tran4 returned NOTHING for all items, fallback to using overall opening stock
            if ([string]$McCode -eq $PrimaryMcCode -and $McTotals.Keys.Count -eq 0) {
                # Fallback: Assume all Folio1 opening stock belongs to Main Store
                foreach ($code in $ItemTotals.Keys) {
                    $McTotals[$code] = $ItemTotals[$code]
                }
                # But we must subtract the TRANSACTIONS of OTHER material centers to avoid double counting
                $SecMcMap = @{}
                foreach ($file in $DbFiles) {
                    $fStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$($file.FullName);Persist Security Info=False;Jet OLEDB:Database Password=$DbPassword;"
                    try {
                        $fc = New-Object -ComObject ADODB.Connection
                        $fc.Open($fStr)
                        $SqlSec = "SELECT MasterCode1, SUM(Value1) AS SumVal FROM Tran2 WHERE MasterCode2 <> $PrimaryMcCode AND MasterCode2 <> 0 AND RecType IN (2, 20) GROUP BY MasterCode1"
                        $rss = $fc.Execute($SqlSec)
                        if ($null -ne $rss -and -not ($rss.EOF -and $rss.BOF)) {
                            while (-not $rss.EOF) {
                                $c = $rss.Fields.Item('MasterCode1').Value
                                $v = $rss.Fields.Item('SumVal').Value
                                if ($null -ne $v -and -not ($v -is [System.DBNull])) {
                                    if (-not $SecMcMap.ContainsKey($c)) { $SecMcMap[$c] = 0 }
                                    $SecMcMap[$c] += [double]$v
                                }
                                $rss.MoveNext()
                            }
                        }
                        $fc.Close()
                    } catch {}
                }
                foreach ($code in $McTotals.Keys) {
                    if ($SecMcMap.ContainsKey($code)) {
                        $McTotals[$code] -= $SecMcMap[$code]
                    }
                }
            }

            $ItemTotals = $McTotals
        }
    }

    $results = @()
    foreach ($code in $ItemTotals.Keys) {
        if ($ItemTotals[$code] -ne 0) {
            $results += @{
                Code = $code
                ItemName = $ItemNames[$code]
                ClosingQty = [Math]::Abs([Math]::Round($ItemTotals[$code], 2))
                RawQty = [Math]::Round($ItemTotals[$code], 2)
            }
        }
    }

    $sorted = $results | Sort-Object { $_.ItemName }
    $sorted | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_BATCH_CLOSING_STOCK") {
    $SearchText = ""
    $McCode = $null
    
    if (-not [string]::IsNullOrWhiteSpace($Data)) {
        if ($Data.Trim().StartsWith("{")) {
            try {
                $DataObj = $Data | ConvertFrom-Json
                if ($null -ne $DataObj.search) { $SearchText = [string]$DataObj.search }
                if ($null -ne $DataObj.mcCode -and [string]$DataObj.mcCode -ne "") { $McCode = [string]$DataObj.mcCode }
            } catch {
                $SearchText = $Data
            }
        } else {
            $SearchText = $Data
        }
    }

    $FilterClause = ""
    if (-not [string]::IsNullOrWhiteSpace($SearchText)) {
        $EscapedData = $SearchText.Replace("'", "''")
        $FilterClause = " AND H.NameAlias LIKE '%$EscapedData%'"
    }

    $McFilter = ""
    if (-not [string]::IsNullOrWhiteSpace($McCode)) {
        $McFilter = " AND I.MCCode = $McCode"
    }

    $Sql = "SELECT H.NameAlias AS ItemName, I.C1 AS BatchNo, SUM(I.Value1) AS ClosingQty 
            FROM ItemParamDet I INNER JOIN Help1 H ON I.ItemCode = H.Code 
            WHERE 1=1 $FilterClause $McFilter 
            GROUP BY H.NameAlias, I.C1"

    $results = @()
    if ($DbType -eq "MSSQL") {
        try {
            $RS = $Conn.Execute($Sql)
            if ($null -ne $RS -and -not ($RS.EOF -and $RS.BOF)) {
                while (-not $RS.EOF) {
                    $qty = $RS.Fields.Item('ClosingQty').Value
                    if ($null -ne $qty -and -not ($qty -is [System.DBNull]) -and $qty -ne 0) {
                        $results += @{
                            ItemName = [string]$RS.Fields.Item('ItemName').Value
                            BatchNo = [string]$RS.Fields.Item('BatchNo').Value
                            ClosingQty = [Math]::Round([double]$qty, 2)
                        }
                    }
                    $RS.MoveNext()
                }
            }
        } catch {
            [Console]::Error.WriteLine("[PS-BRIDGE] MSSQL Batch Stock Error: $($_.Exception.Message)")
        }
    } else {
        # Access Logic
        $CompanyDir = if (Test-Path $DbPath -PathType Container) { $DbPath } else { Split-Path $DbPath }
        $DbFiles = Get-ChildItem -Path $CompanyDir -Filter "db120*.bds" | Sort-Object Name
        if (-not $DbFiles) {
            $DbFiles = Get-ChildItem -Path $CompanyDir -Filter "*.bds" | Where-Object { $_.Name -ne "db.bds" } | Sort-Object Name
        }
        $LatestFile = $DbFiles | Select-Object -Last 1
        if (-not $LatestFile -and (Test-Path $DbPath -PathType Leaf)) {
            $LatestFile = Get-Item -Path $DbPath
        }

        if ($LatestFile) {
            $FileConnStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$($LatestFile.FullName);Persist Security Info=False;Jet OLEDB:Database Password=$DbPassword;"
            try {
                $FConn = New-Object -ComObject ADODB.Connection
                $FConn.Open($FileConnStr)
                $RS = $FConn.Execute($Sql)
                if ($null -ne $RS -and -not ($RS.EOF -and $RS.BOF)) {
                    while (-not $RS.EOF) {
                        $qty = $RS.Fields.Item('ClosingQty').Value
                        if ($null -ne $qty -and -not ($qty -is [System.DBNull]) -and $qty -ne 0) {
                            $results += @{
                                ItemName = [string]$RS.Fields.Item('ItemName').Value
                                BatchNo = [string]$RS.Fields.Item('BatchNo').Value
                                ClosingQty = [Math]::Round([double]$qty, 2)
                            }
                        }
                        $RS.MoveNext()
                    }
                }
                $FConn.Close()
            } catch {
                [Console]::Error.WriteLine("[PS-BRIDGE] Access Batch Stock Error: $($_.Exception.Message)")
            }
        }
    }

    $sorted = $results | Sort-Object { $_.ItemName }
    $sorted | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_PARTY_BY_PHONE") {
    $PhoneDigits = $Data.Replace("+", "").Replace(" ", "").Replace("-", "").Trim()
    if ($PhoneDigits.StartsWith("91") -and $PhoneDigits.Length -eq 12) {
        $ShortPhone = $PhoneDigits.Substring(2)
    } else {
        $ShortPhone = $PhoneDigits
    }
    
    $Sql = "SELECT T1.MasterCode, H1.NameAlias AS PartyName, T1.Mobile, T1.WhatsAppNo 
            FROM MasterAddressInfo T1 LEFT JOIN Help1 H1 ON T1.MasterCode = H1.Code 
            WHERE T1.Mobile LIKE '%$ShortPhone%' OR T1.WhatsAppNo LIKE '%$ShortPhone%' OR T1.Mobile LIKE '%$PhoneDigits%' OR T1.WhatsAppNo LIKE '%$PhoneDigits%'"
            
    $Res = Get-QueryResults $Sql
    $Res | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_PARTY_BY_NAME") {
    $EscapedData = $Data.Replace("'", "''").Trim()
    $Sql = "SELECT T1.MasterCode, H1.NameAlias AS PartyName, T1.Mobile, T1.WhatsAppNo 
            FROM MasterAddressInfo T1 LEFT JOIN Help1 H1 ON T1.MasterCode = H1.Code 
            WHERE H1.NameAlias LIKE '%$EscapedData%' OR H1.Name LIKE '%$EscapedData%'"
            
    $Res = Get-QueryResults $Sql
    $Res | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_BALANCE") {
    # Verified Logic: Sum(Abs(Method 1)) - Sum(Abs(Method 2,3)) - OrphanGap
    # OrphanGap = Abs(T2.Value1 - T3S.S3)
    # Since Orphan is Receipt (type 14), we subtract it.
    $Sql = "SELECT Code, SUM(Balance) as Balance FROM (
                SELECT MasterCode1 as Code, IIf(Method=1, Abs(Value1), -Abs(Value1)) as Balance FROM Tran3 WHERE MasterCode1=$Data
                UNION ALL
                SELECT T2.MasterCode1 as Code, 
                -1 * Abs(T2.Value1 - IIf(T3S.S3 IS NULL, 0, T3S.S3)) as Balance
                FROM (Tran2 T2 LEFT JOIN Tran1 T1 ON T2.VchCode = T1.VchCode)
                LEFT JOIN (SELECT VchCode, SUM(Value1) as S3 FROM Tran3 GROUP BY VchCode) T3S ON T2.VchCode = T3S.VchCode
                WHERE T2.MasterCode1=$Data AND T1.VchType=14 AND T1.Stamp IN (1, 2, 3, 7)
                AND Abs(T2.Value1 - IIf(T3S.S3 IS NULL, 0, T3S.S3)) > 0.1
            ) AS FinalBal GROUP BY Code"
            
    $Res = Get-QueryResults $Sql
    if ($Res.Count -gt 0) {
        $Res[0] | ConvertTo-Json -Compress
    }
    else {
        @{ Balance = 0 } | ConvertTo-Json -Compress
    }
}
elseif ($Action -eq "GET_BALANCES_BULK") {
    $DateQuote = "#"
    $DateFmt = "yyyy-MM-dd"
    if ($DbType -eq "MSSQL") {
        $DateQuote = "'"
        $DateFmt = "yyyy-MM-dd"
    }
    
    # Realized Balance = Sum(Value1 where StockUpdationDate <= Today or NULL)
    # PDC Amount = Sum(Value1 where StockUpdationDate > Today)
    $TodayStr = Get-Date -Format $DateFmt
    $Sql = "SELECT Code, SUM(BalPart) as Balance, SUM(PdcPart) as PDCAmt FROM (
                SELECT T3.MasterCode1 as Code, 
                IIf(T1.StockUpdationDate IS NULL OR T1.StockUpdationDate <= $DateQuote$TodayStr$DateQuote, T3.Value1, 0) as BalPart,
                IIf(T1.StockUpdationDate > $DateQuote$TodayStr$DateQuote, T3.Value1, 0) as PdcPart
                FROM Tran3 T3 LEFT JOIN Tran1 T1 ON T3.VchCode = T1.VchCode 
                WHERE T3.MasterCode1 IN ($Data)
                UNION ALL
                SELECT T2.MasterCode1 as Code, 
                IIf(T1.StockUpdationDate IS NULL OR T1.StockUpdationDate <= $DateQuote$TodayStr$DateQuote, (T2.Value1 - IIf(T3S.S3 IS NULL, 0, T3S.S3)), 0) as BalPart,
                IIf(T1.StockUpdationDate > $DateQuote$TodayStr$DateQuote, (T2.Value1 - IIf(T3S.S3 IS NULL, 0, T3S.S3)), 0) as PdcPart
                FROM (Tran2 T2 LEFT JOIN Tran1 T1 ON T2.VchCode = T1.VchCode)
                LEFT JOIN (SELECT VchCode, SUM(Value1) as S3 FROM Tran3 GROUP BY VchCode) T3S ON T2.VchCode = T3S.VchCode
                WHERE T2.MasterCode1 IN ($Data) AND T1.VchType=14 AND T1.Stamp IN (1, 2, 3, 7)
                AND Abs(T2.Value1 - IIf(T3S.S3 IS NULL, 0, T3S.S3)) > 0.1
            ) AS Combined
            GROUP BY Code"

    $Res = Get-QueryResults $Sql
    $Res | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_BILLS" -or $Action -eq "GET_BILLS_BULK") {
    # Main Bills Query (Tran3)
    # Note: GET_BILLS returns raw Value1. The frontend decides whether to add/subtract based on Method.
    # But for On Account (Gap), we must return the positive amount so frontend can handle it.
    # Assuming frontend treats "On Account" row as a bill or adjustment?
    
    $DateQuote = "#"
    $DateFmt = "yyyy-MM-dd"
    if ($DbType -eq "MSSQL") {
        $DateQuote = "'"
        $DateFmt = "yyyy-MM-dd"
    }
            
    $TodayStr = Get-Date -Format $DateFmt
    $Where = ""
    if ($Action -eq "GET_BILLS") { $Where = "T3.MasterCode1=$Data" }
    else { $Where = "T3.MasterCode1 IN ($Data)" }

    $Sql = "SELECT T3.MasterCode1, T3.[Date], T3.[Value3], T3.[Value1], T3.[DueDate], T3.[Method], T3.[VchCode], T3.Status, T3.NewRefAmount, T3.[No] AS RefNo, T1.Stamp,
            IIf(T1.StockUpdationDate > $DateQuote$TodayStr$DateQuote, 1, 0) as IsActivePDC
            FROM Tran3 T3 LEFT JOIN Tran1 T1 ON T3.VchCode = T1.VchCode 
            WHERE $Where AND (T3.[Method] BETWEEN 1 AND 4)
            UNION ALL
            SELECT T2.MasterCode1, T1.[Date], 0 as Value3, 
            Abs(T2.Value1 - IIf(T3S.S3 IS NULL, 0, T3S.S3)) as Value1,
            NULL as DueDate, 2 as Method, T2.VchCode, 1 as Status, 0 as NewRefAmount, 'On Account' as RefNo, T1.Stamp,
            IIf(T1.StockUpdationDate > $DateQuote$TodayStr$DateQuote, 1, 0) as IsActivePDC
            FROM (Tran2 T2 LEFT JOIN Tran1 T1 ON T2.VchCode = T1.VchCode)
            LEFT JOIN (SELECT VchCode, SUM(Value1) as S3 FROM Tran3 GROUP BY VchCode) T3S ON T2.VchCode = T3S.VchCode
            WHERE " + ($Where.Replace("T3.", "T2.")) + " AND T1.VchType=14 AND T1.Stamp IN (1, 2, 3, 7)
            AND Abs(T2.Value1 - IIf(T3S.S3 IS NULL, 0, T3S.S3)) > 0.1
            ORDER BY 2" # Order by Date

    Get-QueryResults $Sql | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_CONTACT") {
    $Code = [int]$Data
    $Sql = "SELECT MasterCode, Mobile, WhatsAppNo, Email, Address1, Address2, Address3 FROM MasterAddressInfo WHERE MasterCode=$Code"
    $Res = Get-QueryResults $Sql
    $Payload = @{ Address = if ($Res.Count -gt 0) { $Res[0] } else { @{} } }
    $Payload | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_CONTACT_BULK") {
    $Codes = $Data
    # Self-join Help1 to resolve ParentGroup code to NameAlias
    $Sql = "SELECT T1.MasterCode, T1.Mobile, T1.WhatsAppNo, T1.Address1, T1.Address2, T1.Address3, T1.Station, H2.NameAlias as ParentGroup 
            FROM (MasterAddressInfo T1 LEFT JOIN Help1 H1 ON T1.MasterCode = H1.Code) 
            LEFT JOIN Help1 H2 ON H1.ParentGroup = H2.Code 
            WHERE T1.MasterCode IN ($Codes)"
    $Res = Get-QueryResults $Sql
    $Payload = @{ AddressInfo = @($Res) }
    $Payload | ConvertTo-Json -Depth 2 -Compress
}
elseif ($Action -eq "GET_COMPANY_INFO") {
    $MConn = New-Object -ComObject ADODB.Connection
    $MConnOpened = $false

    if ($DbType -eq "MSSQL") {
        # The user mentioned the root database is BusyCompXXXX_db
        # We strip only the yearly 5-digit suffix (e.g. 12024)
        $RootDbName = $DbPath -replace '[0-9]{5}$', '' 

        $MConnStrings = @()
        if (-not [string]::IsNullOrWhiteSpace($DbUser)) {
            $MConnStrings += "Provider=SQLOLEDB;Data Source=$DbServer;Initial Catalog=$RootDbName;User ID=$DbUser;Password=$DbPassword;"
            $MConnStrings += "Provider=MSOLEDBSQL;Data Source=$DbServer;Initial Catalog=$RootDbName;User ID=$DbUser;Password=$DbPassword;"
        }
        $MConnStrings += "Provider=SQLOLEDB;Data Source=$DbServer;Initial Catalog=$RootDbName;Integrated Security=SSPI;"
        $MConnStrings += "Provider=MSOLEDBSQL;Data Source=$DbServer;Initial Catalog=$RootDbName;Integrated Security=SSPI;"

        foreach ($cs in $MConnStrings) {
            try {
                $MConn.Open($cs)
                $MConnOpened = $true
                break
            } catch {}
        }
    }
    else {
        # Access: db.bds contains the company profile. It should be in the company root folder.
        $CompanyFolder = if (Test-Path $DbPath -PathType Container) { $DbPath } else { Split-Path $DbPath }
        $MainDb = Join-Path $CompanyFolder "db.bds"
        
        if (!(Test-Path $MainDb)) {
            $MainDb = Join-Path $CompanyFolder "db.mdb"
        }

        if (!(Test-Path $MainDb)) { Write-Output "{}"; exit }
        $MainConnStr = "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$MainDb;Persist Security Info=False;Jet OLEDB:Database Password=$DbPassword;"
        try {
            $MConn.Open($MainConnStr)
            $MConnOpened = $true
        } catch {}
    }

    if (-not $MConnOpened) { Write-Output "{}"; exit }

    try {
        $Sql = "SELECT Name, Address1, Address2, Address3, Address4, GSTNo FROM Company"
        $MRS = $MConn.Execute($Sql)
        if ($null -ne $MRS -and -not $MRS.EOF) {
            $addrParts = @()
            if ($MRS.Fields.Item('Address1').Value) { $addrParts += $MRS.Fields.Item('Address1').Value.Trim() }
            if ($MRS.Fields.Item('Address2').Value) { $addrParts += $MRS.Fields.Item('Address2').Value.Trim() }
            if ($MRS.Fields.Item('Address3').Value) { $addrParts += $MRS.Fields.Item('Address3').Value.Trim() }
            if ($MRS.Fields.Item('Address4').Value) { $addrParts += $MRS.Fields.Item('Address4').Value.Trim() }
            
            $Info = @{
                Name    = $MRS.Fields.Item("Name").Value
                Address = $addrParts -join ", "
                GSTNo   = $MRS.Fields.Item("GSTNo").Value
            }
            $Info | ConvertTo-Json -Compress
        }
        else { Write-Output "{}" }
        $MConn.Close()
    }
    catch { 
        [Console]::Error.WriteLine("[PS-BRIDGE] GET_COMPANY_INFO Failed: $($_.Exception.Message)")
        Write-Output "{}" 
    }
}

$Conn.Close()
