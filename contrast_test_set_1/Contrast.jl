using DataFrames
using CSV
import NamedTupleTools
import Dates

# create a table without no shows, encoding all other services as boolean columns
df1 = DataFrame(CSV.File("Contrast_Report.csv"))

df1 = df1[df1."Procedure-Related Meds" .!== missing, :]

print(df1)

dftechs = DataFrame(CSV.File("CAMRIS_Technologists.csv"))

print(dftechs)

dfmergewithtechs = leftjoin(dftechs, df1, on = :"Technologist" => :"Technologist", matchmissing=:notequal, source=:source)

dfmergewithtechs = dfmergewithtechs[dfmergewithtechs."source" .!== "left_only", :]

print(dfmergewithtechs)

function extractDate(x)
  if x === missing
    return missing
  end

  parsed_date = Dates.DateTime(x, Dates.DateFormat("m/d/Y HH:MM"))

  #print(Dates.year(parsed_date))

  if Dates.year(parsed_date) < 2000
    parsed_date += Dates.Year(2000)
  end

  return Dates.format(parsed_date, "yyyy-mm-dd") 
end

function extractTime(x)
  if x === missing
    return missing
  end

  return Dates.format(Dates.DateTime(x, Dates.DateFormat("m/d/yy HH:MM")), "HH:MM")
end

select!(dfmergewithtechs,
  :"Begin Exam Time" => (x -> extractDate.(x)) => "date",
  :"Begin Exam Time" => (x -> extractTime.(x)) => "event_time",
  :"Linked Study IRB Number" => "project",
  :"PennKey" => "userid",
  :"Accession #" => "specimen",
  :"Provider/Resource" => "desc2")

dfmergewithtechs.lab .= 7
dfmergewithtechs.sublab .= 0
dfmergewithtechs.code .= "CAMRIS-003"
dfmergewithtechs.desc1 .= "Contrast Injection"
dfmergewithtechs.quantity .= 1 
dfmergewithtechs.bill .= "Y"



print(dfmergewithtechs)

CSV.write("contrast_output.csv", dfmergewithtechs)

