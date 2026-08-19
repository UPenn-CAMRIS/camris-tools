using DataFrames
using CSV
import NamedTupleTools

# create a table without no shows, encoding all other services as boolean columns
df1 = DataFrame(CSV.File("Dogfish_Events.csv"))

df1 = df1[df1."Service" .!= "No Show/Cancellation Fee", :]

function extractIRBProtocolNumberWithoutSuffix(x)
  m =  match(r"\A\d\d\d\d\d\d", x)

  if m === nothing
    return x
  end

  return m.match 
end

select!(df1,
  :"Event ID",
  :"Protocol Number",
  :"Service" => (x -> x .== "Human MRI") => :"Human MRI",
  :"Service" => (x -> x .== "Human MRI (Industry/CHOP)") => :"Human MRI Industry",
  :"Service" => (x -> x .== "Human MRI (Ex-vivo scanning)") => :"Human MRI Ex Vivo",
  :"Service" => (x -> x .== "Animal MRI") => :"Animal MRI",
  :"Service" => (x -> x .== "Animal MRI (Industry/CHOP)") => :"Animal MRI Industry",
  :"Service" => (x -> x .== "Stimulus/Response Equipment Usage Fee") => :"Stimulus",
  :"Service" => (x -> x .== "Research Report Reader Fee") => :"Neuroreader")

df1."Protocol Number" = passmissing(extractIRBProtocolNumberWithoutSuffix).(df1."Protocol Number") 

df1g = groupby(df1, :"Event ID")

#print(df1g)

function orRows(x)
  return last(collect(Iterators.accumulate(|, x)))
end

dfmerge = combine(df1g,
  :"Protocol Number" => first => :"Protocol Number",
  :"Human MRI" => orRows => :"Human MRI",
  :"Human MRI Industry" => orRows => :"Human MRI Industry",
  :"Human MRI Ex Vivo" => orRows => :"Human MRI Ex Vivo",
  :"Animal MRI" => orRows => :"Animal MRI",
  :"Animal MRI Industry" => orRows => :"Animal MRI Industry",
  :"Stimulus" => orRows => :"Stimulus",
  :"Neuroreader" => orRows => :"Neuroreader")

#print(dfmerge)

CSV.write("dfmerge.csv", dfmerge)

#Find all events with no services

#dfnoservices = dfmerge[.!((x -> collect(Iterators.accumulate(|, x[3:end]))[end]).(eachrow(dfmerge))), :]

#print(dfnoservices)

#CSV.write("no_services.csv", dfnoservices)

#Match events with data in CAMS

dfcams = DataFrame(CSV.File("CAMS_Data.csv"))

dfcams."Protocol Number" = passmissing(extractIRBProtocolNumberWithoutSuffix).(dfcams."Protocol Number") 

dfmergewithcams = leftjoin(dfmerge, dfcams, on = :"Protocol Number" => :"Protocol Number", matchmissing=:notequal)

CSV.write("dfmergewithcams.csv", dfmergewithcams)

#Match events with data in RedCap 

dfredcap = DataFrame(CSV.File("Redcap_Export.csv"))

function extractIRBProtocolNumber(x)
  m =  match(r"8\d\d\d\d\d", x)

  if m === nothing
    return x
  end

  return m.match 
end

dfredcap."fixed_irb" = passmissing(extractIRBProtocolNumber).(dfredcap."irb_protocol_number")

filter!(row -> row."camris_review_letter_complete" == 2, dfredcap)

dfredcapg = groupby(dfredcap, :"fixed_irb")

dfredcapactive = combine(dfredcapg,
	:"fixed_irb" => last => :"Protocol Number",
  	:"fees_reviewletter___2" => last => :"RedCap Neuroreader",
  	:"fees_reviewletter___6" => last => :"RedCap Stimulus")

dfmergewithcamsredcap = leftjoin(dfmergewithcams, dfredcapactive, on = :"Protocol Number", matchmissing=:notequal)

CSV.write("dfmergewithcamsredcap.csv", dfmergewithcamsredcap)

#Audit for errors

function isAnimalProtocol(x)
  m =  match(r"\AAR\d\d\d\d\d\d", x)

  if m === nothing
    return false
  end

  return true 
end

function isNotAnimalProtocol(x)
  return ! isAnimalProtocol(x) 
end


dferrors = select(dfmergewithcamsredcap,
  :"Event ID",
  :"Protocol Number",
  [:"Human MRI Industry", :"Animal MRI Industry", :"Industry Sponsored"]  => ((x,y, z) -> (.!(x .|| y)).&& (z .=="Yes")) => :"Industry Billed As Government Error",
  [:"Human MRI Industry", :"Animal MRI Industry", :"Industry Sponsored"]  => ((x,y, z) -> ((x .|| y)).&& (z .!="Yes")) => :"Government Billed As Industry Error",
  [:"Human MRI", :"Human MRI Industry", :"Protocol Number"]  => ((x,y, z) -> (x .|| y).&& isAnimalProtocol.(z)) => :"Animal Billed As Human Error",
  [:"Animal MRI", :"Animal MRI Industry", :"Protocol Number"]  => ((x,y, z) -> (x .|| y).&& (isNotAnimalProtocol.(z))) => :"Human Billed As Animal Error",
  [:"Stimulus", :"RedCap Stimulus"]  => ((x,y) -> map(Base.splat((a, b) -> passmissing(.&)(.!(a),b)), zip(passmissing(Bool).(x), passmissing(Bool).(y)))) => :"Stimulus Billing Missed Error",
  [:"Stimulus", :"RedCap Stimulus"]  => ((x,y) -> map(Base.splat((a, b) -> passmissing(.&)(a,.!(b))), zip(passmissing(Bool).(x), passmissing(Bool).(y)))) => :"Stimulus Billing Extra Error",
  [:"Neuroreader", :"RedCap Neuroreader"]  => ((x,y) -> map(Base.splat((a, b) -> passmissing(.&)(.!(a),b)), zip(passmissing(Bool).(x), passmissing(Bool).(y)))) => :"Neuroreader Billing Missed Error",
  [:"Neuroreader", :"RedCap Neuroreader"]  => ((x,y) -> map(Base.splat((a, b) -> passmissing(.&)(a,.!(b))), zip(passmissing(Bool).(x), passmissing(Bool).(y)))) => :"Neuroreader Billing Extra Error"
  )

#print((x -> (collect(Iterators.accumulate(|, Missings.replace(x[3:end], false)))[end])).(eachrow(dferrors)))

dfonlyerrors = dferrors[(x -> (collect(Iterators.accumulate(|, Missings.replace(x[3:end], true)))[end])).(eachrow(dferrors)), :]

CSV.write("audit_output.csv", dfonlyerrors)

select!(dfonlyerrors, 
  :"Protocol Number",
  :"Industry Billed As Government Error",
  :"Government Billed As Industry Error",
  :"Animal Billed As Human Error",
  :"Human Billed As Animal Error",
  :"Stimulus Billing Missed Error",
  :"Stimulus Billing Extra Error",
  :"Neuroreader Billing Missed Error",
  :"Neuroreader Billing Extra Error")

unique!(dfonlyerrors)

CSV.write("audit_output_unique.csv", dfonlyerrors)
