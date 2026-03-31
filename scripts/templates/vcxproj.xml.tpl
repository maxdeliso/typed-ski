<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" ToolsVersion="Current" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="Debug|x64">
      <Configuration>Debug</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
    <ProjectConfiguration Include="Release|x64">
      <Configuration>Release</Configuration>
      <Platform>x64</Platform>
    </ProjectConfiguration>
  </ItemGroup>
  <PropertyGroup Label="Globals">
    <VCProjectVersion>17.0</VCProjectVersion>
    <Keyword>MakeFileProj</Keyword>
    <ProjectGuid>@0@</ProjectGuid>
    <RootNamespace>@1@</RootNamespace>
    <ProjectName>@2@</ProjectName>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\Microsoft.Cpp.Default.props" />
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'" Label="Configuration">
    <ConfigurationType>Makefile</ConfigurationType>
    <UseDebugLibraries>true</UseDebugLibraries>
    <PlatformToolset>v143</PlatformToolset>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'" Label="Configuration">
    <ConfigurationType>Makefile</ConfigurationType>
    <UseDebugLibraries>false</UseDebugLibraries>
    <PlatformToolset>v143</PlatformToolset>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\Microsoft.Cpp.props" />
  <ImportGroup Label="ExtensionSettings" />
  <ImportGroup Label="Shared" />
  <ImportGroup Label="PropertySheets" Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">
    <Import Project="$(UserRootDir)\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\Microsoft.Cpp.$(Platform).user.props')" Label="LocalAppDataPlatform" />
  </ImportGroup>
  <ImportGroup Label="PropertySheets" Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <Import Project="$(UserRootDir)\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\Microsoft.Cpp.$(Platform).user.props')" Label="LocalAppDataPlatform" />
  </ImportGroup>
  <PropertyGroup Label="UserMacros" />
  <PropertyGroup>
    <OutDir>$(SolutionDir)</OutDir>
    <IntDir>$(SolutionDir).vs\msbuild\$(Configuration)\</IntDir>
    <NMakeBuildCommandLine>@3@</NMakeBuildCommandLine>
    <NMakeReBuildCommandLine>@4@</NMakeReBuildCommandLine>
    <NMakeCleanCommandLine>@5@</NMakeCleanCommandLine>
    <NMakeOutput>@6@</NMakeOutput>
    <NMakeIncludeSearchPath>@7@</NMakeIncludeSearchPath>
    <NMakePreprocessorDefinitions>@8@</NMakePreprocessorDefinitions>
    <ExecutablePath>$(ExecutablePath)</ExecutablePath>
    <LocalDebuggerCommand>@9@</LocalDebuggerCommand>
    <LocalDebuggerCommandArguments>@10@</LocalDebuggerCommandArguments>
    <LocalDebuggerWorkingDirectory>$(ProjectDir)</LocalDebuggerWorkingDirectory>
    <LocalDebuggerDebuggerType>NativeOnly</LocalDebuggerDebuggerType>
    <DebuggerFlavor>WindowsLocalDebugger</DebuggerFlavor>
  </PropertyGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">
    <ClCompile>
      <PreprocessorDefinitions>@11@;$(NMakePreprocessorDefinitions)</PreprocessorDefinitions>
      <AdditionalIncludeDirectories>@12@;$(NMakeIncludeSearchPath)</AdditionalIncludeDirectories>
    </ClCompile>
  </ItemDefinitionGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <ClCompile>
      <PreprocessorDefinitions>@13@;$(NMakePreprocessorDefinitions)</PreprocessorDefinitions>
      <AdditionalIncludeDirectories>@14@;$(NMakeIncludeSearchPath)</AdditionalIncludeDirectories>
    </ClCompile>
  </ItemDefinitionGroup>
  <ItemGroup>
@15@
  </ItemGroup>
  <ItemGroup>
@16@
  </ItemGroup>
  <Import Project="$(VCTargetsPath)\Microsoft.Cpp.targets" />
  <ImportGroup Label="ExtensionTargets" />
</Project>
